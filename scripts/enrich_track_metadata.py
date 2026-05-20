"""Enrich tracks in liked_songs with metadata from Spotify."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
from dotenv import load_dotenv
import psycopg
from lib.spotify import get_spotify_client
from lib.track_metadata import enrich_tracks, get_unenriched_liked_song_uris


def main():
    load_dotenv()
    print("[track-meta] Getting Spotify client...", flush=True)
    sp = get_spotify_client()

    db_url = os.environ["DATABASE_URL"]
    print("[track-meta] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    try:
        print("[track-meta] Finding unenriched liked songs...", flush=True)
        uris = get_unenriched_liked_song_uris(conn)
        print(f"[track-meta] {len(uris)} liked songs need enrichment.", flush=True)

        result = enrich_tracks(sp, conn, uris)
        print(
            f"\n=== Done. Enriched {result['enriched']}/{result['requested']} tracks "
            f"({result['failed']} failed) in {result['duration_s']:.1f}s. ===",
            flush=True,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
