"""Ingest the last 50 Spotify recently-played tracks into spotify_plays."""

import sys
import time

sys.path.insert(0, ".")

from dotenv import load_dotenv
load_dotenv()

from lib.db import get_connection
from lib.spotify_recent import ingest_recent


def main() -> None:
    print("=== Spotify recently-played ingest ===", flush=True)

    start = time.monotonic()

    try:
        conn = get_connection()
        result = ingest_recent(conn)
        conn.close()
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    duration = time.monotonic() - start
    print(
        f"Attempted: {result['attempted']} | "
        f"Inserted: {result['inserted']} | "
        f"Skipped: {result['skipped']} | "
        f"Duration: {duration:.0f}s"
    )


if __name__ == "__main__":
    main()
