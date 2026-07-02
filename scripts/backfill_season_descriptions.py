"""One-off: rewrite existing Spotify season-snapshot playlist descriptions to the
v0.64 astronomical format (via lib.seasons.build_season_description).

Iterates the user's managed playlists, keeps only season snapshots (name contains
the snapshot suffix ' · Auto 🤖📸' AND a season word), parses season + year from the
name, and updates each description on Spotify.

Idempotent — Spotify's playlist_change_details is a plain overwrite, so re-running
just re-writes the same text. Unparseable names are skipped with a warning, never
fatal.

Usage:
    uv run --env-file .env python scripts/backfill_season_descriptions.py --dry-run
    uv run --env-file .env python scripts/backfill_season_descriptions.py
"""

import argparse
import re
import sys
import time
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

from lib.spotify import get_spotify_client
from lib.seasons import build_season_description, season_end

SNAPSHOT_NAME_SUFFIX = " · Auto 🤖📸"
_SEASON_WORDS = ("Spring", "Summer", "Autumn", "Winter")

# Matches a season segment like "Winter 2026" or "Winter 2025/2026".
_SEASON_SEGMENT_RE = re.compile(r"^(Spring|Summer|Autumn|Winter)\s+(\d{4})(?:/(\d{4}))?$")


def _parse_season_playlist(name: str) -> tuple[str, str, int] | None:
    """Parse a season-snapshot playlist name into (prefix, season, start_year).

    prefix       — description prefix, e.g. 'Top 50 tracks' (from the leading segment).
    season       — lowercase SeasonName.
    start_year   — lib.seasons START-year convention (winter 2025 = winter 2025/2026).

    Returns None if the name can't be parsed as a season snapshot.
    """
    parts = [p.strip() for p in name.split("·")]
    if len(parts) < 2:
        return None

    season_segment = None
    for part in parts:
        if _SEASON_SEGMENT_RE.match(part):
            season_segment = part
            break
    if season_segment is None:
        return None

    m = _SEASON_SEGMENT_RE.match(season_segment)
    season = m.group(1).lower()
    year1 = int(m.group(2))
    year2 = m.group(3)

    if season == "winter":
        # "Winter 2025/2026" → start year 2025; "Winter 2026" (end-year naming) → 2025.
        start_year = year1 if year2 else year1 - 1
    else:
        start_year = year1

    prefix = f"{parts[0]} tracks"  # e.g. "Top 50" → "Top 50 tracks"
    return prefix, season, start_year


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill season snapshot descriptions.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print every update without calling the Spotify API.",
    )
    args = parser.parse_args()

    load_dotenv()
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]

    # Enumerate the user's playlists (same pagination pattern as the refresh script).
    print("[backfill] Fetching playlist library...", flush=True)
    playlists: list[tuple[str, str]] = []  # (id, name)
    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        items = page.get("items", []) or []
        for p in items:
            if p and p.get("owner", {}).get("id") == user_id and p.get("name"):
                playlists.append((p["id"], p["name"]))
        if len(items) < 50:
            break
        offset += 50

    season_snapshots = [
        (pid, name)
        for pid, name in playlists
        if SNAPSHOT_NAME_SUFFIX in name and any(w in name for w in _SEASON_WORDS)
    ]
    print(f"[backfill] Found {len(season_snapshots)} candidate season snapshots.", flush=True)

    updated = 0
    for pid, name in season_snapshots:
        parsed = _parse_season_playlist(name)
        if parsed is None:
            print(f"WARNING: could not parse season/year from '{name}' — skipping.", flush=True)
            continue
        prefix, season, start_year = parsed

        try:
            # created_on == day after the season ended == the next season's opening
            # equinox/solstice (e.g. Winter 2025/2026 → 20 mrt 2026).
            created_on = season_end(season, start_year) + timedelta(days=1)
            new_description = build_season_description(prefix, season, start_year, created_on)
        except ValueError as e:
            print(f"WARNING: '{name}' outside boundary table ({e}) — skipping.", flush=True)
            continue

        prefix_label = "[dry-run] Updated" if args.dry_run else "Updated"
        print(f"{prefix_label}: '{name}' → '{new_description}'", flush=True)

        if not args.dry_run:
            sp.playlist_change_details(pid, description=new_description)
            time.sleep(0.5)  # be gentle on the Spotify API

        updated += 1

    verb = "Would backfill" if args.dry_run else "Backfilled"
    print(f"{verb} {updated} season playlist descriptions.", flush=True)


if __name__ == "__main__":
    main()
