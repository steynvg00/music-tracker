"""Sync Spotify Liked Songs into the liked_songs table."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
from dotenv import load_dotenv
import psycopg
from lib.spotify import get_spotify_client
from lib.liked_songs import sync_liked_songs


def main():
    load_dotenv()
    print("[liked-songs] Getting Spotify client...", flush=True)
    sp = get_spotify_client()

    db_url = os.environ["DATABASE_URL"]
    print("[liked-songs] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    try:
        result = sync_liked_songs(sp, conn)
        print(f"\n=== Done. {result['fetched']} liked songs synced in {result['duration_s']:.1f}s. ===", flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
