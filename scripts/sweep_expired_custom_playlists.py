"""Daily sweep: delete expired custom playlists from Spotify + DB."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
from dotenv import load_dotenv
import psycopg
from lib.spotify import get_spotify_client
from lib.temporary_playlists import delete_expired_custom_playlists


def main():
    load_dotenv()
    print("[sweep] Getting Spotify client...", flush=True)
    sp = get_spotify_client()

    db_url = os.environ["DATABASE_URL"]
    print("[sweep] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    try:
        result = delete_expired_custom_playlists(sp, conn)
        print(
            f"\n=== Done. Expired: {result['expired']}, "
            f"deleted on Spotify: {result['deleted_spotify']}, "
            f"deleted in DB: {result['deleted_db']}, "
            f"failed: {result['failed']}. ===",
            flush=True,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
