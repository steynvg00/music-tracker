"""Compute and store normalized popularity scores for all tracks with 20+ plays."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
from dotenv import load_dotenv
import psycopg
from lib.track_popularity import MIN_PLAYS_FOR_SCORING, compute_and_store_scores


def main():
    load_dotenv()
    db_url = os.environ["DATABASE_URL"]

    print(
        f"[track-popularity] Opening DB connection "
        f"(threshold: {MIN_PLAYS_FOR_SCORING}+ plays)...",
        flush=True,
    )
    conn = psycopg.connect(db_url)

    try:
        result = compute_and_store_scores(conn)
        print(
            f"\n=== Done. {result['rows_inserted']} inserted "
            f"(replaced {result['before_count']} old rows) "
            f"in {result['runtime_seconds']:.1f}s. ===",
            flush=True,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
