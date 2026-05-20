"""Refresh all managed auto-playlists in lib.playlists.MANAGED_PLAYLISTS."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import time
from dotenv import load_dotenv
import psycopg
from lib.spotify import get_spotify_client
from lib.playlists import MANAGED_PLAYLISTS, update_managed_playlist, get_full_name


def main():
    load_dotenv()
    print("[playlists] Getting Spotify client...", flush=True)
    sp = get_spotify_client()
    print("[playlists] Fetching current user...", flush=True)
    user_id = sp.current_user()["id"]
    print(f"[playlists] Logged in as {user_id}.", flush=True)

    db_url = os.environ["DATABASE_URL"]
    print("[playlists] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    total = len(MANAGED_PLAYLISTS)
    start = time.time()
    for i, definition in enumerate(MANAGED_PLAYLISTS, start=1):
        full_name = get_full_name(definition)
        print(f"\n[{i}/{total}] {full_name}", flush=True)
        try:
            result = update_managed_playlist(sp, conn, user_id, definition)
            print(f"    {result['track_count']} tracks → {result['action']}", flush=True)
        except Exception as e:
            print(f"    FAILED: {e}", flush=True)
            continue

    conn.close()
    duration = time.time() - start
    print(f"\n=== Done. {total} playlists processed in {duration:.1f}s. ===", flush=True)


if __name__ == "__main__":
    main()
