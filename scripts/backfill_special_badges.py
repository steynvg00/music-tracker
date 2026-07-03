"""One-off: backfill badge_events with every historical special badge (v0.67 / v0.67.1).

Runs each detection function in FULL mode (batch_track_uris=None) and awards what it
finds with send_mail=False — a decade of historical badge alerts would be inbox spam,
so the backfill is silent. Run it once against production AFTER merge and BEFORE the
next ingest cron, so live detection only mails genuinely new crossings.

Covered badge types (v0.67.1 release-timing rename/split):
  streak_5_years, streak_10_years, plays_20_in_day, plays_40_in_day,
  played_on_day_one, comeback, season_regular, multi_top
  + day_one_fan / release_week_fan / late_bloomer — these have no full-mode detector
    (they trigger from the plays_50 crossing at runtime), so the backfill sweeps every
    track with ≥50 plays through detect_release_timing_at_50_plays (which now returns a
    LIST of applicable badges per track) to seed them historically.

awarded_at is the true historical crossing time (carried in each context's 'awarded_at'
key and lifted onto the column by award_special_badge); multi_top awards at NOW() since
it is a live "current state" achievement.

Idempotent: ON CONFLICT DO NOTHING on the windowed unique index (migration 0015), and
every detector already skips already-awarded rows. Safe to re-run.

Usage:
    uv run --env-file .env python scripts/backfill_special_badges.py --dry-run
    uv run --env-file .env python scripts/backfill_special_badges.py
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv()

from lib.db import get_connection
from lib.badges import (
    SPECIAL_BADGE_TYPES,
    award_special_badge,
    detect_streak_badges,
    detect_daily_intensity_badges,
    detect_release_timing_badges,
    detect_comeback_badges,
    detect_season_regular_badge,
    detect_multi_top_badge,
    detect_release_timing_at_50_plays,
    _has_badge,
)


def _release_timing_at_50_full(conn):
    """Full-mode wrapper for the plays_50-triggered release-timing badges (day_one_fan /
    release_week_fan / late_bloomer): sweep every track with ≥50 plays through the check,
    which now returns a LIST of applicable badges per track, skipping already-awarded ones."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT track_uri FROM spotify_plays
            WHERE track_uri IS NOT NULL
            GROUP BY track_uri HAVING COUNT(*) >= 50
            """
        )
        uris = [row[0] for row in cur.fetchall()]

    out = []
    for uri in uris:
        for badge_type, ctx in detect_release_timing_at_50_plays(conn, uri):
            if not _has_badge(conn, uri, badge_type):
                out.append((uri, badge_type, ctx))
    return out


# Each entry: (label, full-mode callable(conn) -> list[(track_uri, badge_type, context)]).
_DETECTORS = [
    ("streaks", detect_streak_badges),
    ("daily intensity", detect_daily_intensity_badges),
    ("release timing (on-release-day)", detect_release_timing_badges),
    ("release timing (@50 plays)", _release_timing_at_50_full),
    ("comeback", detect_comeback_badges),
    ("season_regular", detect_season_regular_badge),
    ("multi_top", detect_multi_top_badge),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill historical special badges (v0.67.1).")
    parser.add_argument("--dry-run", action="store_true", default=False,
                        help="Run every detector and print the distribution, but award nothing.")
    args = parser.parse_args()

    conn = get_connection()
    distribution = {bt: 0 for bt in SPECIAL_BADGE_TYPES}
    total = 0

    try:
        for label, detector in _DETECTORS:
            crossings = detector(conn)
            print(f"[backfill] {label}: {len(crossings)} detected.", flush=True)
            for track_uri, badge_type, context in crossings:
                if args.dry_run:
                    distribution[badge_type] = distribution.get(badge_type, 0) + 1
                    total += 1
                elif award_special_badge(conn, track_uri, badge_type, context, send_mail=False):
                    distribution[badge_type] = distribution.get(badge_type, 0) + 1
                    total += 1
    finally:
        conn.close()

    dist_str = ", ".join(f"{bt}={distribution[bt]}" for bt in SPECIAL_BADGE_TYPES)
    verb = "Would backfill" if args.dry_run else "Backfilled"
    print(f"\n{verb} {total} special badges. Distribution: {dist_str}", flush=True)


if __name__ == "__main__":
    main()
