"""Ingest Spotify Extended Streaming History JSON exports into spotify_plays."""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, ".")

from dotenv import load_dotenv
load_dotenv()

from lib.db import get_connection
from lib.spotify_history import ingest_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest Spotify Extended Streaming History JSON into spotify_plays."
    )
    parser.add_argument("--path", required=True, help="JSON file or directory of JSON files")
    parser.add_argument("--dry-run", action="store_true", help="Parse and count only, no DB writes")
    parser.add_argument("--verbose", action="store_true", help="Per-file progress + sample records")
    args = parser.parse_args()

    target = Path(args.path)
    if not target.exists():
        print(f"Error: path does not exist: {target}", file=sys.stderr)
        sys.exit(1)

    print("=== Spotify Extended Streaming History ingestion ===")
    if args.dry_run:
        print("DRY RUN — no data will be written to the database.")
    print(f"Source: {target.resolve()}")
    print()

    start = time.monotonic()

    try:
        conn = get_connection()
        result = ingest_path(conn, target, dry_run=args.dry_run, verbose=args.verbose)
        conn.close()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    duration = time.monotonic() - start

    print()
    if args.dry_run:
        print("Note: 'would' counts assume an empty DB. Actual run may skip more if rows already exist.")
    print("=== Spotify Extended ingestion complete ===")
    print(f"Files processed:           {result['files_processed']}")
    print(f"Records attempted:         {result['attempted']}")
    if args.dry_run:
        print(f"Would insert:              {result['inserted']}")
        print(f"Would skip (already in DB):{result['skipped']}")
    else:
        print(f"Inserted:                  {result['inserted']}")
        print(f"Skipped (already in DB):   {result['skipped']}")
    print(f"Duration:                  {duration:.0f}s")


if __name__ == "__main__":
    main()
