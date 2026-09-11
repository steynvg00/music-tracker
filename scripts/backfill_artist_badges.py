"""One-off: backfill badge_events with every historical artist badge (v0.74, Part B).

Runs each artist detector in FULL mode (batch_artist_ids=None) and awards what it finds
with send_mail=False — a decade of historical artist-badge alerts would be inbox spam, so
the backfill is silent. Run it once against production AFTER the track backfill (dominant/
sovereign there depend on top_1st_month data) and BEFORE the next cron, so live detection
only mails genuinely new crossings.

Covered (21 types):
  Cumulative plays   artist_plays_{100..5000}    — full-mode detector
  Distinct tracks    artist_tracks_{5..100}      — full-mode detector
  Streaks            artist_streak_{3,5,10}_years — full-mode detector
  Rediscovery        rediscovery                 — full-mode detector
  Dynasty            dynasty                     — live all-time-Top-100 state
  Rankings           top_1st_artist_{month,season,year,alltime} — recomputed per
                     completed period from spotify_plays (no stored membership), mirroring
                     how create_snapshots awards them going forward. decade: none until 2030.

Idempotent: ON CONFLICT DO NOTHING on the windowed unique index, and every detector skips
already-awarded rows. Safe to re-run.

Usage:
    uv run --env-file .env python scripts/backfill_artist_badges.py --dry-run
    uv run --env-file .env python scripts/backfill_artist_badges.py
"""

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv()

from datetime import datetime as _dt, time as _time, timedelta

from lib.db import get_connection
from lib.badges import TZ_AMSTERDAM, _play_date_span, _completed_seasons, _end_of_day_iso, _end_of_month_iso
from lib.seasons import season_start, season_end, season_display_year
from lib.artist_badges import (
    ARTIST_BADGE_TYPES,
    detect_artist_play_milestones,
    detect_artist_distinct_tracks_milestones,
    detect_artist_streaks,
    detect_dynasty_badges,
    detect_rediscovery_badges,
    _artist_aggregate,
)

# The all-credited artist-of-period ranking: rank artists by their in-period plays and take
# the winner (the workshop's stated definition: `... GROUP BY artist_id ORDER BY COUNT(*)
# DESC LIMIT 1`). One light GROUP BY per period — far cheaper than rank_period_tracks (full
# track ranking + name hydration), which repeatedly timed out the free-tier connection over
# ~160 periods. create_snapshots keeps the snapshot-aggregation method going forward (there
# the ranked list is already computed for free); both pick the same period winner.
_TOP_ARTIST_IN_RANGE = """
SELECT aid, COUNT(*) AS plays
FROM spotify_plays sp
JOIN track_metadata tm ON tm.track_uri = sp.track_uri
CROSS JOIN LATERAL unnest(tm.artist_ids) AS aid
WHERE sp.track_uri IS NOT NULL
  AND sp.played_at >= %s AND sp.played_at < %s
GROUP BY aid
ORDER BY plays DESC, aid
LIMIT 1
"""


def _ams_midnight(d: date) -> _dt:
    return _dt.combine(d, _time(0, 0), TZ_AMSTERDAM)


def _ranking_awards(conn):
    """Recompute the #1 artist of every completed month/season/year (+ all-time) from
    spotify_plays and return their top_1st_artist_* awards with a period-end awarded_at.

    Uses its own fresh connection and a light per-period GROUP BY so the ~160 recomputations
    survive the free-tier connection (rank_period_tracks was too heavy and kept timing out).
    """
    rconn = get_connection()
    try:
        span = _play_date_span(rconn)
        if span is None:
            return []
        min_d, max_d = span
        today = datetime.now(TZ_AMSTERDAM).date()
        out: list[tuple[str, str, dict]] = []

        def _add(kind, display, start_dt, end_dt, awarded_at_iso):
            with rconn.cursor() as cur:
                cur.execute(_TOP_ARTIST_IN_RANGE, (start_dt, end_dt))
                row = cur.fetchone()
            if not row:
                return
            out.append((row[0], f"top_1st_artist_{kind}", {
                "window": display,
                "plays": int(row[1]),
                "awarded_at": awarded_at_iso,
            }))

        # Completed months: first play month up to (but excluding) the current month.
        y, m = min_d.year, min_d.month
        while (y, m) < (today.year, today.month):
            nxt = date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)
            _add("month", f"{date(y, m, 1):%B %Y}",
                 _ams_midnight(date(y, m, 1)), _ams_midnight(nxt), _end_of_month_iso(date(y, m, 1)))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)

        # Completed years: first play year up to (but excluding) the current year.
        for yr in range(min_d.year, today.year):
            _add("year", str(yr),
                 _ams_midnight(date(yr, 1, 1)), _ams_midnight(date(yr + 1, 1, 1)),
                 _end_of_day_iso(date(yr, 12, 31)))

        # Completed seasons overlapping the play range.
        for season, start_year, _display, end in _completed_seasons(today, min_d, max_d):
            s_start = season_start(season, start_year)
            s_end = season_end(season, start_year)
            display = f"{season.capitalize()} {season_display_year(season, start_year)}"
            _add("season", display,
                 _ams_midnight(s_start), _ams_midnight(s_end + timedelta(days=1)),
                 _end_of_day_iso(end))

        # All-time: the artist with the most all-credited plays over the whole history.
        agg = _artist_aggregate(rconn, None)
        if agg:
            top_artist_id, (plays, _tracks, _first) = max(agg.items(), key=lambda kv: kv[1][0])
            out.append((top_artist_id, "top_1st_artist_alltime", {
                "window": "All-time",
                "plays": int(plays),
                "awarded_at": _end_of_day_iso(max_d),
            }))

        return out
    finally:
        rconn.close()


# Each entry: (label, full-mode callable(conn) -> list[(artist_id, badge_type, context)]).
_DETECTORS = [
    ("cumulative plays", detect_artist_play_milestones),
    ("distinct tracks", detect_artist_distinct_tracks_milestones),
    ("streaks (3/5/10y)", detect_artist_streaks),
    ("rediscovery", detect_rediscovery_badges),
    ("dynasty", detect_dynasty_badges),
    ("rankings (month/season/year/alltime)", _ranking_awards),
]


_INSERT_NO_AT = (
    "INSERT INTO badge_events (entity_type, entity_id, badge_type, context) "
    "VALUES ('artist', %s, %s, %s::jsonb) "
    "ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window')) DO NOTHING"
)
_INSERT_WITH_AT = (
    "INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context) "
    "VALUES ('artist', %s, %s, %s, %s::jsonb) "
    "ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window')) DO NOTHING"
)


def _bulk_award(conn, crossings, chunk: int = 200) -> None:
    """Insert artist badge rows in chunks, committing per chunk (ON CONFLICT DO NOTHING).

    Far fewer round-trips than per-row award_artist_badge (used by the live crons, which
    award only a handful per run) — the backfill inserts thousands at once, and per-row
    commits over the free-tier Supabase SSL connection were dropping mid-loop.
    """
    with_at, without_at = [], []
    for artist_id, badge_type, context in crossings:
        ctx = dict(context)
        at_iso = ctx.pop("awarded_at", None)
        if at_iso:
            with_at.append((artist_id, badge_type, datetime.fromisoformat(at_iso), json.dumps(ctx)))
        else:
            without_at.append((artist_id, badge_type, json.dumps(ctx)))

    with conn.cursor() as cur:
        for rows, stmt in ((without_at, _INSERT_NO_AT), (with_at, _INSERT_WITH_AT)):
            for i in range(0, len(rows), chunk):
                cur.executemany(stmt, rows[i : i + chunk])
                conn.commit()


def _db_distribution(conn) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT badge_type, COUNT(*) FROM badge_events WHERE entity_type = 'artist' "
            "GROUP BY badge_type"
        )
        return {bt: c for bt, c in cur.fetchall()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill historical artist badges (v0.74).")
    parser.add_argument("--dry-run", action="store_true", default=False,
                        help="Run every detector and print the distribution, but award nothing.")
    args = parser.parse_args()

    conn = get_connection()
    detected = {bt: 0 for bt in ARTIST_BADGE_TYPES}
    total_detected = 0

    try:
        for label, detector in _DETECTORS:
            crossings = detector(conn)
            print(f"[backfill-artist] {label}: {len(crossings)} detected.", flush=True)
            for _artist_id, badge_type, _context in crossings:
                detected[badge_type] = detected.get(badge_type, 0) + 1
                total_detected += 1
            if not args.dry_run and crossings:
                _bulk_award(conn, crossings)

        if args.dry_run:
            dist = detected
            verb = "Would backfill"
            total = total_detected
        else:
            # Authoritative post-insert counts straight from the DB (ON CONFLICT dedups,
            # so the true total is what's actually in badge_events for entity_type='artist').
            db = _db_distribution(conn)
            dist = {bt: db.get(bt, 0) for bt in ARTIST_BADGE_TYPES}
            verb = "Backfilled — artist badge_events now total"
            total = sum(dist.values())
    finally:
        conn.close()

    dist_str = ", ".join(f"{bt}={dist[bt]}" for bt in ARTIST_BADGE_TYPES)
    print(f"\n{verb} {total} artist badges. Distribution: {dist_str}", flush=True)


if __name__ == "__main__":
    main()
