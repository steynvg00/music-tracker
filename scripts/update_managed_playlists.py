"""Refresh all managed auto-playlists via lib.playlists.get_managed_playlists."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import os
import subprocess
import time
from dotenv import load_dotenv
import psycopg
from lib.spotify import get_spotify_client
from lib.playlists import get_managed_playlists, update_managed_playlist, get_full_name

_INGEST_SCRIPT = Path(__file__).resolve().parent / "ingest_spotify_recent.py"


def _run_fresh_ingest() -> None:
    result = subprocess.run(
        [sys.executable, str(_INGEST_SCRIPT)],
        capture_output=True,
        text=True,
    )
    if result.stdout:
        print(result.stdout, end="", flush=True)
    if result.stderr:
        print(result.stderr, end="", flush=True)
    if result.returncode != 0:
        raise RuntimeError(f"ingest_spotify_recent.py exited with code {result.returncode}")


def main():
    parser = argparse.ArgumentParser(description="Refresh all managed auto-playlists.")
    parser.add_argument(
        "--fresh-ingest",
        action="store_true",
        default=False,
        help="Run ingest_spotify_recent.py before refreshing to ensure plays are up to date.",
    )
    args = parser.parse_args()

    if args.fresh_ingest:
        print("[playlists] Running fresh ingest before refresh...", flush=True)
        try:
            _run_fresh_ingest()
            print("[playlists] Fresh ingest complete.", flush=True)
        except Exception as err:
            print(
                f"[playlists] WARNING: Fresh ingest failed: {err}. "
                "Proceeding with potentially stale data.",
                flush=True,
            )

    load_dotenv()
    print("[playlists] Getting Spotify client...", flush=True)
    sp = get_spotify_client()
    print("[playlists] Fetching current user...", flush=True)
    user_id = sp.current_user()["id"]
    print(f"[playlists] Logged in as {user_id}.", flush=True)

    print("[playlists] Building playlist library cache...", flush=True)
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
    print(f"[playlists] Cached {len(playlist_cache)} existing playlists.", flush=True)

    db_url = os.environ["DATABASE_URL"]
    print("[playlists] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    definitions = get_managed_playlists(conn, sp)
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

    conn.close()
    duration = time.time() - start
    print(f"\n=== Done. {total} playlists processed in {duration:.1f}s. ===", flush=True)


if __name__ == "__main__":
    main()
