"""Refresh Elsewhere (YouTube / SoundCloud) metadata (v0.84, R4). See lib/collections_refresh.py.

  uv run python scripts/refresh_collections.py

Also runs inside the daily hub-jobs task (scripts/run_hub_job.py --daily). Needs DATABASE_URL and
YOUTUBE_API_KEY (without the key, YouTube data older than 30 days is deleted, never kept).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os  # noqa: E402

import psycopg  # noqa: E402
from dotenv import load_dotenv  # noqa: E402

from lib.collections_refresh import refresh  # noqa: E402


def main() -> int:
    load_dotenv()
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    try:
        summary = refresh(conn)
    finally:
        conn.close()
    print(f"[collections] {summary}", flush=True)
    return 1 if summary["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
