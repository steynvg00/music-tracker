"""One-off backfill: seed badge_events with every historical play-milestone crossing.

Run manually against the production DATABASE_URL AFTER applying the badge_events
migration and BEFORE deploying the live detection code, so the first ingest cron
only fires mails for genuinely new crossings.

Sends NO mails. Idempotent via ON CONFLICT DO NOTHING — safe to re-run.
awarded_at is set to the actual historical crossing timestamp (the played_at of
the Nth play), NOT NOW().

Usage:
    uv run python scripts/backfill_play_milestones.py            # insert
    uv run python scripts/backfill_play_milestones.py --dry-run  # preview only
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv()

from lib.db import get_connection

THRESHOLDS = [50, 100, 200, 300, 400, 500]

# For each track, the played_at of its 50th / 100th / ... play — i.e. the moment
# it crossed each milestone. Lesson #17: filter out NULL track_uri.
_CROSSINGS_SQL = """
SELECT track_uri, played_at, rn
FROM (
    SELECT
        track_uri,
        played_at,
        ROW_NUMBER() OVER (PARTITION BY track_uri ORDER BY played_at ASC) AS rn
    FROM spotify_plays
    WHERE track_uri IS NOT NULL
) ranked
WHERE rn IN (50, 100, 200, 300, 400, 500)
ORDER BY track_uri, rn
"""

_INSERT_SQL = """
INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
VALUES ('track', %(track_uri)s, %(badge_type)s, %(awarded_at)s, '{"backfilled": true}'::jsonb)
ON CONFLICT (entity_type, entity_id, badge_type) DO NOTHING
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill play-milestone badge_events.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Run the crossings query and print the summary, but insert nothing.",
    )
    args = parser.parse_args()

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(_CROSSINGS_SQL)
            crossings = cur.fetchall()  # (track_uri, played_at, rn)

        rows = [
            {"track_uri": track_uri, "badge_type": f"plays_{rn}", "awarded_at": played_at}
            for track_uri, played_at, rn in crossings
        ]

        distribution = {n: 0 for n in THRESHOLDS}
        tracks = set()
        for track_uri, _played_at, rn in crossings:
            distribution[rn] += 1
            tracks.add(track_uri)

        if args.dry_run:
            print("[backfill] DRY RUN — no rows inserted.", flush=True)
            inserted = 0
        else:
            with conn.cursor() as cur:
                cur.executemany(_INSERT_SQL, rows)
                inserted = cur.rowcount if cur.rowcount >= 0 else 0
            conn.commit()

        dist_str = ", ".join(f"plays_{n}={distribution[n]}" for n in THRESHOLDS)
        verb = "Would backfill" if args.dry_run else "Backfilled"
        print(
            f"{verb} {len(rows)} badge_events across {len(tracks)} tracks. "
            f"Distribution: {dist_str}",
            flush=True,
        )
        if not args.dry_run:
            print(
                f"[backfill] Inserted {inserted} new rows "
                f"({len(rows) - inserted} already existed).",
                flush=True,
            )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
