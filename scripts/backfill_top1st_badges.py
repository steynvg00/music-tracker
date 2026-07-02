"""One-off: backfill top_1st_* badges from existing Spotify snapshot playlists.

For every managed snapshot playlist (name contains ' · Auto 🤖📸'), parse its
period, take its #1 track (Spotify position 1), and award the matching top_1st_*
badge with awarded_at = the period-end date and a populated context.

Scope note (v0.65): month / season / year snapshots are backfilled. 'All-Time ·
YYYY' snapshots are intentionally SKIPPED (top_1st_alltime stays unpopulated for
now — the Rankings row shows an em-dash); decade snapshots don't exist yet.

Idempotent via award_top_1st_badge's ON CONFLICT on the windowed unique index
(migration 0015). Run --dry-run first.

Usage:
    uv run --env-file .env python scripts/backfill_top1st_badges.py --dry-run
    uv run --env-file .env python scripts/backfill_top1st_badges.py
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

from lib.spotify import get_spotify_client
from lib.db import get_connection
from lib.playlists import (
    _MONTH_NAMES,
    snapshot_period_spec,
    count_period_plays,
)
from lib.badges import award_top_1st_badge

SNAPSHOT_NAME_SUFFIX = " · Auto 🤖📸"

_MONTH_RE = re.compile(r"^(" + "|".join(_MONTH_NAMES) + r")\s+(\d{4})$")
_SEASON_RE = re.compile(r"^(Spring|Summer|Autumn|Winter)\s+(\d{4})$")
_YEAR_RE = re.compile(r"^(\d{4})$")


def _parse_snapshot(name: str):
    """Parse a snapshot playlist name into (kind, identifier), or None to skip."""
    if "All-Time" in name:
        return None  # v0.65 does not backfill top_1st_alltime
    parts = [p.strip() for p in name.split("·")]

    for part in parts:
        m = _MONTH_RE.match(part)
        if m:
            month = _MONTH_NAMES.index(m.group(1)) + 1
            return ("month", (int(m.group(2)), month))
        m = _SEASON_RE.match(part)
        if m:
            season = m.group(1).lower()
            name_year = int(m.group(2))  # END-year naming for winter
            start_year = name_year - 1 if season == "winter" else name_year
            return ("season", (season, start_year))

    for part in parts:
        if _YEAR_RE.match(part):  # bare 4-digit segment → Top 100 · YYYY year snapshot
            return ("year", int(part))
    return None


def _top_two_uris(sp, playlist_id: str) -> list[str]:
    """Return the first two track URIs of a playlist, in order."""
    page = sp.playlist_items(playlist_id, limit=2, offset=0, fields="items.track.uri")
    uris = []
    for item in page.get("items", []) or []:
        track = item.get("track") or {}
        if track.get("uri"):
            uris.append(track["uri"])
    return uris


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill top_1st_* badges from snapshot playlists.")
    parser.add_argument("--dry-run", action="store_true", default=False)
    args = parser.parse_args()

    load_dotenv()
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]
    conn = get_connection()

    print("[backfill] Fetching playlist library...", flush=True)
    snapshots: list[tuple[str, str]] = []  # (id, name)
    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        items = page.get("items", []) or []
        for p in items:
            if p and p.get("owner", {}).get("id") == user_id and p.get("name"):
                if SNAPSHOT_NAME_SUFFIX in p["name"]:
                    snapshots.append((p["id"], p["name"]))
        if len(items) < 50:
            break
        offset += 50
    print(f"[backfill] Found {len(snapshots)} snapshot playlists.", flush=True)

    per_kind: dict[str, int] = {}
    processed = 0
    badges = 0

    for pid, name in snapshots:
        parsed = _parse_snapshot(name)
        if parsed is None:
            print(f"[backfill] Skipping (not month/season/year): '{name}'", flush=True)
            continue
        kind, identifier = parsed

        try:
            spec = snapshot_period_spec(kind, identifier)
        except ValueError as e:
            print(f"WARNING: '{name}' outside supported range ({e}) — skipping.", flush=True)
            continue

        uris = _top_two_uris(sp, pid)
        if not uris:
            print(f"WARNING: '{name}' has no tracks — skipping.", flush=True)
            continue

        top_uri = uris[0]
        runner_up = uris[1] if len(uris) > 1 else None
        counts = count_period_plays(conn, [u for u in (top_uri, runner_up) if u], kind, identifier)
        plays_1 = counts.get(top_uri, 0)
        rank_2_gap = (plays_1 - counts.get(runner_up, 0)) if runner_up else None

        context = {
            "window": spec["display_name"],
            "plays_in_window": plays_1,
            "rank_2_track_uri": runner_up,
            "rank_2_gap": rank_2_gap,
        }
        processed += 1
        per_kind[kind] = per_kind.get(kind, 0) + 1

        if args.dry_run:
            print(f"[dry-run] top_1st_{kind} → {spec['display_name']}: #1={top_uri} "
                  f"({plays_1} plays, gap={rank_2_gap}) awarded_at={spec['period_end']}", flush=True)
            badges += 1
        else:
            inserted = award_top_1st_badge(conn, top_uri, kind, context, awarded_at=spec["period_end"])
            action = "awarded" if inserted else "already existed"
            print(f"top_1st_{kind} {action} → {spec['display_name']}: #1={top_uri}", flush=True)
            if inserted:
                badges += 1

    conn.close()
    dist = ", ".join(f"{k}={per_kind[k]}" for k in sorted(per_kind))
    verb = "Would backfill" if args.dry_run else "Backfilled"
    print(f"\n{verb} {badges} top_1st_* badges across {processed} snapshot playlists. "
          f"Distribution: {dist}", flush=True)


if __name__ == "__main__":
    main()
