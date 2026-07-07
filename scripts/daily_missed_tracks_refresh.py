"""Daily cron (03:00 UTC): refresh the two Missed New Tracks playlists.

v0.72: these moved off the weekly refresh to a daily cadence so newly-eligible releases
surface promptly. Each run does one Spotify sweep of every followed artist's recent
releases, keeps the unplayed ones in the 7–60-day age window (7-day delay, ~2-month
expiry), and splits them into:
  - Missed new tracks · popular artists  (credited to a top-50 most-played artist)
  - Missed new tracks · other artists    (the rest)

Runs at 03:00, before the 05:00 create-snapshots cron and clear of the Monday 06:00 weekly
refresh. No digest email — a daily digest would be a flood; the run logs its summary to the
GitHub Actions console.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import time

from dotenv import load_dotenv
import psycopg

from lib.spotify import get_spotify_client
from lib.playlists import get_managed_playlists, update_managed_playlist, get_full_name


def main() -> None:
    load_dotenv()
    print("[daily-missed] Getting Spotify client...", flush=True)
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]
    print(f"[daily-missed] Logged in as {user_id}.", flush=True)

    print("[daily-missed] Building playlist library cache...", flush=True)
    playlist_cache: dict[str, str] = {}
    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        items = page.get("items", []) or []
        for p in items:
            if p and p.get("name"):
                playlist_cache[p["name"]] = p["id"]
        if len(items) < 50:
            break
        offset += 50
    print(f"[daily-missed] Cached {len(playlist_cache)} existing playlists.", flush=True)

    conn = psycopg.connect(os.environ["DATABASE_URL"])

    # The two "daily" definitions share a cached Spotify sweep (lib.playlists._get_missed_split),
    # so building both and refreshing them in sequence costs exactly one followed-artist scan.
    definitions = [
        d for d in get_managed_playlists(conn, sp)
        if d.kind != "snapshot" and d.cadence == "daily"
    ]
    total = len(definitions)
    start = time.time()
    for i, definition in enumerate(definitions, start=1):
        full_name = get_full_name(definition)
        print(f"\n[{i}/{total}] {full_name}", flush=True)
        try:
            result = update_managed_playlist(sp, conn, user_id, definition, playlist_cache)
            print(f"    {result['track_count']} tracks → {result['action']}", flush=True)
        except Exception as e:
            print(f"    FAILED: {e}", flush=True)
            continue

    duration = time.time() - start
    print(f"\n=== Done. {total} missed-tracks playlists processed in {duration:.1f}s. ===", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
