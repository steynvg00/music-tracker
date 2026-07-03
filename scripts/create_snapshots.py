"""Daily 05:00 cron: create period snapshots the morning after a period ends.

Detects month/season/year/decade period-ends by comparing yesterday vs today,
then for each ended period: creates the snapshot playlist, awards the top_1st_*
badge to the #1 track, and sends a dedicated snapshot mail.

Failure of any single period-end event is non-fatal: it's logged and the script
continues, exiting 0 so the GitHub Action step stays green. State is self-healing —
if a playlist got created but its badge didn't, the next run's idempotency check
(no badge for this window) re-processes it; if the badge exists, the whole event
is skipped, so no duplicate mail.

Flags:
    --dry-run              detect + preview only; no Spotify writes, no badge, no mail
    --force-date YYYY-MM-DD override "today" (for testing a period-end without waiting)
"""

import argparse
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

from lib.db import get_connection
from lib.seasons import get_season_containing
from lib.playlists import (
    SNAPSHOT_NAME_SUFFIX,
    snapshot_period_spec,
    rank_period_tracks,
    create_month_snapshot,
    create_season_snapshot,
    create_year_snapshot,
    create_decade_snapshot,
)
from lib.badges import award_top_1st_badge, award_special_badge, detect_season_regular_badge
from lib.snapshot_notify import build_and_send_snapshot_mail

TZ_AMSTERDAM = ZoneInfo("Europe/Amsterdam")

_CREATE_DISPATCH = {
    "month": lambda sp, uid, conn, ident: create_month_snapshot(sp, uid, conn, ident[0], ident[1]),
    "season": lambda sp, uid, conn, ident: create_season_snapshot(sp, uid, conn, ident[0], ident[1]),
    "year": lambda sp, uid, conn, ident: create_year_snapshot(sp, uid, conn, ident),
    "decade": lambda sp, uid, conn, ident: create_decade_snapshot(sp, uid, conn, ident),
}


def detect_ended_periods(today: date) -> list[dict]:
    """Returns period-end events that completed yesterday. Each dict:
    {"kind": "month"|"season"|"year"|"decade", "identifier": <key>, "display_name": <str>}.
    """
    yesterday = today - timedelta(days=1)
    events: list[dict] = []

    # Month: today is day 1 of a new month → last month ended.
    if today.day == 1:
        events.append({"kind": "month", "identifier": (yesterday.year, yesterday.month)})

    # Season: yesterday and today fall in different seasons.
    season_yesterday = get_season_containing(yesterday)
    season_today = get_season_containing(today)
    if season_yesterday != season_today:
        season, start_year = season_yesterday
        events.append({"kind": "season", "identifier": (season, start_year)})

    # Year: today is Jan 1 → last year ended.
    if today.month == 1 and today.day == 1:
        events.append({"kind": "year", "identifier": yesterday.year})
        # Decade: Jan 1 of a decade-start year (2030, 2040, ...) → last decade ended.
        if today.year % 10 == 0:
            events.append({"kind": "decade", "identifier": today.year - 10})

    # Attach display_name from the single source of truth (matches badge window + name).
    for event in events:
        event["display_name"] = snapshot_period_spec(event["kind"], event["identifier"])["display_name"]
    return events


def _already_processed(conn, kind: str, window: str) -> bool:
    """True if a top_1st_{kind} badge already exists for this window (idempotency)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM badge_events
            WHERE entity_type = 'track'
              AND badge_type = %s
              AND context->>'window' = %s
            LIMIT 1
            """,
            (f"top_1st_{kind}", window),
        )
        return cur.fetchone() is not None


def _build_context(display_name: str, ranked: list[dict]) -> dict:
    top = ranked[0]
    if len(ranked) > 1:
        runner_up = ranked[1]
        rank_2_track_uri = runner_up["track_uri"]
        rank_2_gap = top["plays_in_period"] - runner_up["plays_in_period"]
    else:
        rank_2_track_uri = None
        rank_2_gap = None
    return {
        "window": display_name,
        "plays_in_window": top["plays_in_period"],
        "rank_2_track_uri": rank_2_track_uri,
        "rank_2_gap": rank_2_gap,
    }


def _process_event(sp, user_id, conn, event: dict, dry_run: bool) -> None:
    kind = event["kind"]
    identifier = event["identifier"]
    display_name = event["display_name"]
    spec = snapshot_period_spec(kind, identifier)
    playlist_name = f"{spec['suffix']}{SNAPSHOT_NAME_SUFFIX}"

    if _already_processed(conn, kind, display_name):
        print(f"[create-snapshots] {display_name} ({kind}) already processed — skipping.", flush=True)
        return

    if dry_run:
        ranked = rank_period_tracks(conn, kind, identifier)
        if not ranked:
            print(f"[create-snapshots] {display_name} ({kind}): no plays in period — would skip.", flush=True)
            return
        top = ranked[0]
        ctx = _build_context(display_name, ranked)
        print(f"[create-snapshots] {display_name} ({kind}):", flush=True)
        print(f"    would create playlist '{playlist_name}' with {len(ranked)} tracks", flush=True)
        print(f"    would award top_1st_{kind} to #1 '{top['track_name']}' "
              f"({top['artist_display']}) — {top['plays_in_period']} plays", flush=True)
        print(f"    badge context: {ctx}", flush=True)
        print(f"    would send snapshot mail: 'music-tracker: {display_name} snapshot ready'", flush=True)
        return

    playlist_id, ranked = _CREATE_DISPATCH[kind](sp, user_id, conn, identifier)
    print(f"[create-snapshots] Created '{playlist_name}' ({len(ranked)} tracks).", flush=True)
    if not ranked:
        print(f"[create-snapshots] {display_name}: empty period, no badge/mail.", flush=True)
        return

    top = ranked[0]
    context = _build_context(display_name, ranked)
    inserted = award_top_1st_badge(conn, top["track_uri"], kind, context)
    if inserted:
        print(f"[create-snapshots] Awarded top_1st_{kind} to '{top['track_name']}'.", flush=True)
        build_and_send_snapshot_mail(conn, kind, display_name, playlist_name, ranked)
    else:
        print(f"[create-snapshots] top_1st_{kind} for {display_name} already existed — skipping mail.", flush=True)

    # v0.67: a fresh season snapshot may push a track over the season_regular threshold
    # (top 25 of ≥3 seasons). Detection recomputes all past seasons, so we scope it to
    # this snapshot's top 25. Non-fatal — never breaks snapshot creation.
    if kind == "season":
        try:
            candidates = [t["track_uri"] for t in ranked[:25]]
            for track_uri, badge_type, ctx in detect_season_regular_badge(conn, batch_track_uris=candidates):
                if award_special_badge(conn, track_uri, badge_type, ctx, send_mail=True):
                    print(f"[create-snapshots] Awarded season_regular to {track_uri}.", flush=True)
        except Exception as e:
            print(f"WARNING: season_regular detection failed: {e}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create period snapshots the day after a period ends.")
    parser.add_argument("--dry-run", action="store_true", default=False,
                        help="Detect + preview only; no Spotify writes, badge inserts, or mail.")
    parser.add_argument("--force-date", type=str, default=None,
                        help="Override today (YYYY-MM-DD) for testing.")
    args = parser.parse_args()

    load_dotenv()

    today = date.fromisoformat(args.force_date) if args.force_date else datetime.now(TZ_AMSTERDAM).date()
    print(f"=== create-snapshots (today={today.isoformat()}"
          f"{' DRY-RUN' if args.dry_run else ''}) ===", flush=True)

    events = detect_ended_periods(today)
    if not events:
        print("[create-snapshots] No period-ends today. Nothing to do.", flush=True)
        return

    print(f"[create-snapshots] Detected {len(events)} period-end(s): "
          f"{', '.join(f'{e['kind']}={e['display_name']}' for e in events)}", flush=True)

    conn = get_connection()
    sp = None
    user_id = None
    if not args.dry_run:
        from lib.spotify import get_spotify_client
        sp = get_spotify_client()
        user_id = sp.current_user()["id"]

    for event in events:
        try:
            _process_event(sp, user_id, conn, event, args.dry_run)
        except Exception as e:
            # Non-fatal: log and continue with the next period-end.
            print(f"ERROR processing {event.get('display_name')} ({event.get('kind')}): {e}",
                  file=sys.stderr)

    conn.close()
    print("=== create-snapshots done ===", flush=True)


if __name__ == "__main__":
    main()
