"""Mid-month cron (15th, 06:00 UTC): refresh the "mid_month"-cadence playlists.

v0.72: currently just Forgotten favorites (50+ plays, untouched 2 years). Refreshed on
the 15th rather than weekly so the re-discovery set turns over on a calmer monthly beat.
No digest email — a daily/monthly flood was deliberately avoided; the run logs its summary
to the GitHub Actions console instead.
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
    print("[mid-month] Getting Spotify client...", flush=True)
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]
    print(f"[mid-month] Logged in as {user_id}.", flush=True)

    print("[mid-month] Building playlist library cache...", flush=True)
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
    print(f"[mid-month] Cached {len(playlist_cache)} existing playlists.", flush=True)

    conn = psycopg.connect(os.environ["DATABASE_URL"])

    definitions = [
        d for d in get_managed_playlists(conn, sp)
        if d.kind != "snapshot" and d.cadence == "mid_month"
    ]
    total = len(definitions)
    start = time.time()
    for i, definition in enumerate(definitions, start=1):
        full_name = get_full_name(definition)
        print(f"\n[{i}/{total}] {full_name}", flush=True)
        try:
            # No collector: these are non-Top playlists, no rank history / no email.
            result = update_managed_playlist(sp, conn, user_id, definition, playlist_cache)
            print(f"    {result['track_count']} tracks → {result['action']}", flush=True)
        except Exception as e:
            print(f"    FAILED: {e}", flush=True)
            continue

    duration = time.time() - start
    print(f"\n=== Done. {total} mid-month playlists processed in {duration:.1f}s. ===", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
