"""Archive the last.fm-era `scrobbles` table to a compressed CSV in a folder you choose (v0.90).

READ-ONLY: this script never writes to, alters or drops anything in the database. Dropping the table
is migration 0033_drop_scrobbles_AFTER_ARCHIVE.sql, which you apply by hand AFTER this printed
VERIFIED (paste the SET line it prints above the migration; 0033 refuses without it).

What it does, inside ONE read-only REPEATABLE READ snapshot (so the count, the checksums and the
export all see exactly the same rows):
  1. counts the rows and computes per-column checksums in SQL (sums of ids, of microsecond
     timestamps, of ms_played, text lengths, shuffle true/false counts);
  2. streams `COPY (SELECT … ORDER BY id) TO STDOUT (FORMAT csv, HEADER)` into
     <out-dir>/scrobbles_<UTC timestamp>.csv.gz (never overwrites a file);
  3. re-reads the .csv.gz from disk and recomputes the row count, the SHA-256 of the CSV and the
     same per-column checksums from the file, and compares them with step 1;
  4. writes <name>.manifest.json next to it (rows, SHA-256 of the CSV and of the .gz, checksums).
Exit code 0 + "VERIFIED" only when every comparison matches; anything else exits non-zero.

Usage:
    uv run python scripts/archive_scrobbles.py --out-dir ~/Backups/music-tracker
    uv run python scripts/archive_scrobbles.py --out-dir DIR --db postgresql://…   # instead of DATABASE_URL
    uv run python scripts/archive_scrobbles.py --verify DIR/scrobbles_….csv.gz     # re-check an archive
The folder must be outside this git repository (a 38 MB table must never end up in a commit).
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

COLUMNS = ["id", "track_id", "played_at", "source", "ms_played", "reason_start", "reason_end", "shuffle", "created_at"]
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# Same definitions in SQL (step 1) and in Python over the file (step 3).
CHECKSUM_SQL = """
SELECT count(*)::bigint                                                   AS rows,
       coalesce(sum(id), 0)::numeric                                      AS sum_id,
       coalesce(sum(track_id), 0)::numeric                                AS sum_track_id,
       coalesce(sum(extract(epoch FROM played_at) * 1000000), 0)::numeric AS sum_played_us,
       coalesce(sum(extract(epoch FROM created_at) * 1000000), 0)::numeric AS sum_created_us,
       coalesce(sum(ms_played), 0)::numeric                               AS sum_ms_played,
       count(ms_played)::bigint                                           AS n_ms_played,
       coalesce(sum(length(source)), 0)::bigint                           AS len_source,
       coalesce(sum(length(reason_start)), 0)::bigint                     AS len_reason_start,
       coalesce(sum(length(reason_end)), 0)::bigint                       AS len_reason_end,
       count(*) FILTER (WHERE shuffle)::bigint                            AS n_shuffle_true,
       count(*) FILTER (WHERE NOT shuffle)::bigint                        AS n_shuffle_false,
       coalesce(min(id), 0)::bigint                                       AS min_id,
       coalesce(max(id), 0)::bigint                                       AS max_id
FROM scrobbles
"""
COPY_SQL = (
    "COPY (SELECT id, track_id, played_at, source, ms_played, reason_start, reason_end, shuffle, created_at "
    "FROM scrobbles ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER true)"
)


def _ts_us(s: str) -> int:
    """'2019-03-01 12:00:00.123456+00' (TimeZone UTC) → microseconds since the epoch, exactly."""
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    d = dt - EPOCH
    return (d.days * 86_400 + d.seconds) * 1_000_000 + d.microseconds


def checksums_from_csv(text_stream) -> dict[str, int]:
    """Recompute CHECKSUM_SQL's numbers from the exported CSV (header first, NULL = empty field)."""
    r = csv.reader(text_stream)
    header = next(r, None)
    if header != COLUMNS:
        raise ValueError(f"unexpected CSV header: {header}")
    c = dict.fromkeys(
        ["rows", "sum_id", "sum_track_id", "sum_played_us", "sum_created_us", "sum_ms_played", "n_ms_played",
         "len_source", "len_reason_start", "len_reason_end", "n_shuffle_true", "n_shuffle_false"], 0)
    min_id = max_id = None
    for row in r:
        if len(row) != len(COLUMNS):
            raise ValueError(f"row {c['rows'] + 1}: {len(row)} fields")
        rid, track_id, played_at, source, ms_played, rs, re_, shuffle, created_at = row
        c["rows"] += 1
        i = int(rid)
        c["sum_id"] += i
        min_id = i if min_id is None else min(min_id, i)
        max_id = i if max_id is None else max(max_id, i)
        c["sum_track_id"] += int(track_id)
        c["sum_played_us"] += _ts_us(played_at)
        c["sum_created_us"] += _ts_us(created_at)
        if ms_played != "":
            c["sum_ms_played"] += int(ms_played)
            c["n_ms_played"] += 1
        c["len_source"] += len(source)
        c["len_reason_start"] += len(rs)
        c["len_reason_end"] += len(re_)
        if shuffle == "t":
            c["n_shuffle_true"] += 1
        elif shuffle == "f":
            c["n_shuffle_false"] += 1
    c["min_id"] = min_id or 0
    c["max_id"] = max_id or 0
    return c


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_back(path: Path) -> tuple[dict[str, int], str]:
    """Checksums + SHA-256 of the decompressed CSV, read from disk."""
    h = hashlib.sha256()

    class Tee(io.RawIOBase):
        def __init__(self, f):
            self.f = f

        def readable(self):
            return True

        def readinto(self, b):
            data = self.f.read(len(b))
            h.update(data)
            b[: len(data)] = data
            return len(data)

    with gzip.open(path, "rb") as gz:
        text = io.TextIOWrapper(io.BufferedReader(Tee(gz)), encoding="utf-8", newline="")
        sums = checksums_from_csv(text)
        # Drain anything csv didn't read (it reads to EOF, but be explicit for the hash).
        while text.read(1 << 20):
            pass
    return sums, h.hexdigest()


def compare(db: dict[str, int], file: dict[str, int]) -> list[str]:
    return [f"{k}: database {db[k]} ≠ file {file.get(k)}" for k in db if int(db[k]) != int(file.get(k, -1))]


def inside_repo(path: Path) -> bool:
    try:
        top = subprocess.run(["git", "-C", str(Path(__file__).resolve().parent), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return False
    try:
        path.resolve().relative_to(Path(top).resolve())
        return True
    except ValueError:
        return False


def db_checksums(cur) -> dict[str, int]:
    cur.execute(CHECKSUM_SQL)
    names = [d.name for d in cur.description]
    return {k: int(v) for k, v in zip(names, cur.fetchone())}


def connect(url: str):
    import psycopg  # imported here: the module itself has no side effects and no hard dependency on import

    conn = psycopg.connect(url, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        cur.execute("SET TIME ZONE 'UTC'")
        cur.execute("SET statement_timeout = 0")
    conn.commit()
    return conn


def export(url: str, out_dir: Path, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"scrobbles_{now.strftime('%Y%m%dT%H%M%SZ')}"
    gz_path = out_dir / f"{stem}.csv.gz"
    manifest_path = out_dir / f"{stem}.manifest.json"
    conn = connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.scrobbles') IS NOT NULL")
            if not cur.fetchone()[0]:
                print("scrobbles does not exist (already dropped by 0033?). Nothing to archive.", file=sys.stderr)
                return 3
            db_sums = db_checksums(cur)  # same snapshot as the COPY below (REPEATABLE READ)
            h = hashlib.sha256()
            with open(gz_path, "xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as gz:
                with cur.copy(COPY_SQL) as copy:
                    for chunk in copy:
                        b = bytes(chunk)
                        h.update(b)
                        gz.write(b)
        conn.rollback()  # read-only: nothing to commit
    finally:
        conn.close()
    csv_sha = h.hexdigest()
    file_sums, csv_sha_back = read_back(gz_path)
    problems = compare(db_sums, file_sums)
    if csv_sha_back != csv_sha:
        problems.append(f"sha256 of the CSV: written {csv_sha} ≠ read back {csv_sha_back}")
    manifest = {
        "table": "scrobbles",
        "file": gz_path.name,
        "created_at": now.isoformat(),
        "rows": db_sums["rows"],
        "columns": COLUMNS,
        "sha256_csv": csv_sha,
        "sha256_gz": sha256_file(gz_path),
        "bytes_gz": gz_path.stat().st_size,
        "checksums": db_sums,
        "verified": not problems,
    }
    with open(manifest_path, "x", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"archive:  {gz_path} ({gz_path.stat().st_size:,} bytes, {db_sums['rows']:,} rows)")
    print(f"manifest: {manifest_path}")
    print(f"sha256 (csv): {csv_sha}")
    if problems:
        print("NOT VERIFIED — do NOT apply 0033:", *problems, sep="\n  ", file=sys.stderr)
        return 2
    print("VERIFIED: row count, SHA-256 and every column checksum match the database snapshot.")
    print("To drop the table, paste this line above migrations/0033_drop_scrobbles_AFTER_ARCHIVE.sql in the SQL editor:")
    print(f"SET rotor.scrobbles_archived_rows = '{db_sums['rows']}';")
    return 0


def verify(url: str | None, gz_path: Path) -> int:
    manifest_path = gz_path.with_name(gz_path.name.replace(".csv.gz", ".manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    file_sums, csv_sha = read_back(gz_path)
    problems = compare(manifest["checksums"], file_sums)
    if csv_sha != manifest["sha256_csv"]:
        problems.append(f"sha256 of the CSV {csv_sha} ≠ manifest {manifest['sha256_csv']}")
    if sha256_file(gz_path) != manifest["sha256_gz"]:
        problems.append("sha256 of the .gz differs from the manifest")
    if url:
        conn = connect(url)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.scrobbles') IS NOT NULL")
                if cur.fetchone()[0]:
                    problems += [f"database now: {p}" for p in compare(db_checksums(cur), file_sums)]
                else:
                    print("(scrobbles no longer exists: checked the file against its manifest only)")
            conn.rollback()
        finally:
            conn.close()
    if problems:
        print("NOT VERIFIED:", *problems, sep="\n  ", file=sys.stderr)
        return 2
    print(f"VERIFIED: {file_sums['rows']:,} rows, sha256 {csv_sha}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Archive the scrobbles table to CSV.gz (read-only; never drops it).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--out-dir", type=Path, help="local folder for the archive (outside this repository)")
    g.add_argument("--verify", type=Path, help="re-verify an existing .csv.gz against its manifest (and the DB, if reachable)")
    ap.add_argument("--db", help="database URL (default: DATABASE_URL from the environment / .env)")
    ap.add_argument("--allow-in-repo", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    url = args.db
    if not url:
        try:
            from dotenv import load_dotenv

            load_dotenv()
        except ImportError:
            pass
        url = os.environ.get("DATABASE_URL")
    if args.verify:
        return verify(url, args.verify.expanduser())
    if not url:
        print("No database: pass --db or set DATABASE_URL.", file=sys.stderr)
        return 1
    out = args.out_dir.expanduser()
    if inside_repo(out) and not args.allow_in_repo:
        print(f"Refusing: {out} is inside the git repository. Choose a folder outside it.", file=sys.stderr)
        return 1
    return export(url, out)


if __name__ == "__main__":
    sys.exit(main())
