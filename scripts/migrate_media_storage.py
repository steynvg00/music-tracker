"""Copy every Rotor media object to a new S3-compatible backend and verify checksums (v0.94).

DRY RUN BY DEFAULT: lists what would be copied and touches nothing. Pass --execute to copy.

    # source = the current backend (MEDIA_S3_* in .env); destination = DEST_MEDIA_S3_*
    uv run python scripts/migrate_media_storage.py                 # dry run
    uv run python scripts/migrate_media_storage.py --execute       # copy + verify

For each object under tracks/, sets/ and covers/:
  1. download from the source, computing SHA-256 on the way (streamed to a temp file, never in memory)
  2. upload to the destination under the SAME key (signed with that SHA-256)
  3. download it back from the destination and compare SHA-256 and size
Objects already present at the destination with the same size are re-verified by checksum and skipped
when they match. The database is not touched: object keys are backend-independent, so after a clean
run you switch the hub's MEDIA_S3_* env vars to the destination and redeploy. The source is never
modified or deleted (remove it yourself once the hub plays from the new backend).

Exit code 0 = everything verified (or dry run), 1 = a mismatch or error (details printed).
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lib.media_storage import Backend, S3Client, StorageError  # noqa: E402

PREFIXES = ("tracks/", "sets/", "covers/")


def fmt_mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB"


def plan(src: S3Client, dst: S3Client, prefixes=PREFIXES):
    """(to_copy, to_verify): objects missing/different at the destination, and same-size ones to re-check."""
    to_copy, to_verify = [], []
    for p in prefixes:
        dest = {o.key: o.size for o in dst.list_objects(p)}
        for o in src.list_objects(p):
            (to_verify if dest.get(o.key) == o.size else to_copy).append(o)
    return to_copy, to_verify


def migrate(src: S3Client, dst: S3Client, execute: bool, out=print, prefixes=PREFIXES) -> int:
    to_copy, to_verify = plan(src, dst, prefixes)
    total = sum(o.size for o in to_copy)
    out(f"Source:      {src.b.describe()}")
    out(f"Destination: {dst.b.describe()}")
    out(f"To copy: {len(to_copy)} object(s), {fmt_mb(total)} · already there (same size, checksum re-checked): {len(to_verify)}")
    if not execute:
        for o in to_copy[:50]:
            out(f"  would copy {o.key} ({fmt_mb(o.size)})")
        if len(to_copy) > 50:
            out(f"  … and {len(to_copy) - 50} more")
        out("DRY RUN: nothing was copied. Run again with --execute to copy and verify.")
        return 0
    failures = 0
    for o in to_copy:
        try:
            with tempfile.TemporaryFile() as t:
                sha, n, ctype = src.download(o.key, t)
                if n != o.size:
                    raise StorageError(f"source size changed while reading ({n} != {o.size})")
                dst.upload(o.key, t, n, sha, ctype)
            back, m = dst.sha256_of(o.key)
            if back != sha or m != n:
                raise StorageError(f"checksum mismatch after copy (source {sha[:12]}…, destination {back[:12]}…, {m} bytes)")
            out(f"  copied + verified {o.key} ({fmt_mb(n)}, sha256 {sha[:12]}…)")
        except StorageError as e:
            failures += 1
            out(f"  FAILED {o.key}: {e}")
    for o in to_verify:
        try:
            a, _ = src.sha256_of(o.key)
            b, _ = dst.sha256_of(o.key)
            if a != b:
                raise StorageError(f"same size but different content (source {a[:12]}…, destination {b[:12]}…); delete it at the destination and re-run")
            out(f"  already there, verified {o.key}")
        except StorageError as e:
            failures += 1
            out(f"  FAILED {o.key}: {e}")
    out(f"Done: {len(to_copy)} copied, {len(to_verify)} re-verified, {failures} failure(s).")
    if failures:
        out("NOT safe to switch: fix the failures and run again.")
        return 1
    out("All objects verified. Switch the hub's MEDIA_S3_* variables to the destination, redeploy, then play a file to check.")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--execute", action="store_true", help="copy for real (default: dry run)")
    ap.add_argument("--source-prefix", default="MEDIA_S3_", help="env prefix of the source backend (default MEDIA_S3_)")
    ap.add_argument("--dest-prefix", default="DEST_MEDIA_S3_", help="env prefix of the destination (default DEST_MEDIA_S3_)")
    ap.add_argument("--no-dotenv", action="store_true", help="don't read .env (use the process environment only)")
    args = ap.parse_args(argv)
    if not args.no_dotenv:
        try:
            from dotenv import load_dotenv  # optional, like the other scripts

            load_dotenv(ROOT / ".env")
        except ImportError:
            pass
    try:
        src = S3Client(Backend.from_env(args.source_prefix))
        dst = S3Client(Backend.from_env(args.dest_prefix))
    except StorageError as e:
        print(f"Configuration: {e}", file=sys.stderr)
        return 2
    if (src.b.endpoint, src.b.bucket) == (dst.b.endpoint, dst.b.bucket):
        print("Source and destination are the same bucket: nothing to do.", file=sys.stderr)
        return 2
    try:
        return migrate(src, dst, args.execute)
    except StorageError as e:
        print(f"Storage error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
