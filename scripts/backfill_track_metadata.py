"""One-shot backfill: enrich all played tracks with Spotify metadata + artist arrays.

Resumable: re-running after an interruption skips already-enriched tracks.
Expected runtime: ~10 min for ~584 batches of 50 tracks.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import time
from dotenv import load_dotenv
import psycopg
import spotipy

from lib.spotify import get_spotify_client


BATCH_SIZE = 50
SLEEP_BETWEEN_BATCHES = 1.1  # seconds — keeps us well under Spotify's rate limit
SLEEP_ON_RATE_LIMIT = 60     # seconds — back-off on 429
LOG_EVERY_N_BATCHES = 10


def get_unenriched_uris(conn) -> list[str]:
    """Return distinct track_uris from spotify_plays still needing enrichment."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT DISTINCT sp.track_uri
        FROM spotify_plays sp
        WHERE sp.track_uri IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM track_metadata tm
              WHERE tm.track_uri = sp.track_uri
                AND tm.artist_ids IS NOT NULL
          )
        ORDER BY sp.track_uri
        """
    )
    return [row[0] for row in cur.fetchall()]


def fetch_batch_with_retry(sp, track_ids: list[str]) -> list:
    """Call sp.tracks(), retrying once after a 60s sleep on 429."""
    for attempt in range(2):
        try:
            response = sp.tracks(track_ids)
            return response.get("tracks", []) or []
        except spotipy.exceptions.SpotifyException as e:
            if e.http_status == 429 and attempt == 0:
                print(
                    f"[backfill] WARNING: 429 rate limit. Sleeping {SLEEP_ON_RATE_LIMIT}s before retry...",
                    flush=True,
                )
                time.sleep(SLEEP_ON_RATE_LIMIT)
            else:
                raise
    return []


def upsert_track(cur, track: dict) -> bool:
    """UPSERT a single track dict into track_metadata. Returns True on success."""
    uri = track.get("uri")
    if not uri:
        return False

    album = track.get("album") or {}
    release_date = album.get("release_date")
    release_precision = album.get("release_date_precision")
    release_year = None
    if release_date and len(release_date) >= 4:
        try:
            release_year = int(release_date[:4])
        except ValueError:
            release_year = None

    artists = track.get("artists") or []
    artist_ids = [a["id"] for a in artists if a and a.get("id")] or None
    artist_names = [a["name"] for a in artists if a and a.get("name")] or None

    cur.execute(
        """
        INSERT INTO track_metadata (
            track_uri, release_date, release_year, release_date_precision,
            duration_ms, popularity, explicit, album_id,
            artist_ids, artist_names, enriched_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (track_uri) DO UPDATE SET
            release_date = EXCLUDED.release_date,
            release_year = EXCLUDED.release_year,
            release_date_precision = EXCLUDED.release_date_precision,
            duration_ms = EXCLUDED.duration_ms,
            popularity = EXCLUDED.popularity,
            explicit = EXCLUDED.explicit,
            album_id = EXCLUDED.album_id,
            artist_ids = EXCLUDED.artist_ids,
            artist_names = EXCLUDED.artist_names,
            enriched_at = NOW()
        """,
        (
            uri,
            release_date,
            release_year,
            release_precision,
            track.get("duration_ms"),
            track.get("popularity"),
            track.get("explicit"),
            album.get("id"),
            artist_ids,
            artist_names,
        ),
    )
    return True


def print_verification(conn):
    """Print coverage report and sample artist arrays."""
    cur = conn.cursor()

    cur.execute("SELECT COUNT(DISTINCT track_uri) FROM spotify_plays WHERE track_uri IS NOT NULL")
    total_played = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM track_metadata WHERE artist_ids IS NOT NULL")
    total_enriched = cur.fetchone()[0]

    coverage = (total_enriched / total_played * 100) if total_played else 0

    print("\n=== Coverage report ===", flush=True)
    print(f"Distinct track_uri in spotify_plays: {total_played:,}", flush=True)
    print(f"track_metadata rows with artist_ids: {total_enriched:,}", flush=True)
    print(f"Coverage: {coverage:.1f}%", flush=True)

    cur.execute(
        """
        SELECT tm.track_uri, tm.artist_names
        FROM track_metadata tm
        WHERE tm.artist_names IS NOT NULL
        ORDER BY RANDOM()
        LIMIT 10
        """
    )
    rows = cur.fetchall()

    print("\n=== Sample artist arrays (10 random rows) ===", flush=True)
    for track_uri, artist_names in rows:
        print(f"{track_uri} | artist_names = {artist_names}", flush=True)

    cur.execute(
        """
        SELECT COUNT(*)
        FROM track_metadata
        WHERE artist_ids IS NOT NULL
          AND array_length(artist_ids, 1) > 1
        """
    )
    multi_count = cur.fetchone()[0]

    print(f"\n=== Multi-artist tracks (artist_ids length > 1) ===", flush=True)
    print(f"{multi_count:,} tracks have multiple artists.", flush=True)


def main():
    load_dotenv()

    print("[backfill] Getting Spotify client...", flush=True)
    sp = get_spotify_client()

    db_url = os.environ["DATABASE_URL"]
    print("[backfill] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    try:
        print("[backfill] Querying unenriched tracks...", flush=True)
        all_uris = get_unenriched_uris(conn)
        total = len(all_uris)
        print(f"[backfill] {total:,} tracks need enrichment.", flush=True)

        if total == 0:
            print("[backfill] Nothing to do.", flush=True)
            print_verification(conn)
            return

        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
        enriched = 0
        failed_uris: list[str] = []
        start = time.time()
        cur = conn.cursor()

        for batch_num, i in enumerate(range(0, total, BATCH_SIZE), start=1):
            uri_batch = all_uris[i:i + BATCH_SIZE]
            id_batch = [u.replace("spotify:track:", "") for u in uri_batch]

            if batch_num > 1:
                time.sleep(SLEEP_BETWEEN_BATCHES)

            tracks = fetch_batch_with_retry(sp, id_batch)

            for track in tracks:
                if track is None:
                    # Spotify returns null for unavailable/deleted tracks
                    failed_uris.append("(unknown — null response in batch)")
                    continue
                if upsert_track(cur, track):
                    enriched += 1
                else:
                    failed_uris.append(track.get("uri", "(no uri)"))

            conn.commit()

            if batch_num % LOG_EVERY_N_BATCHES == 0 or batch_num == total_batches:
                pct = enriched / total * 100 if total else 0
                elapsed = time.time() - start
                print(
                    f"[backfill] Enriched {enriched:,}/{total:,} tracks ({pct:.1f}%) "
                    f"— batch {batch_num}/{total_batches} — {elapsed:.0f}s elapsed",
                    flush=True,
                )

        elapsed = time.time() - start
        print(
            f"\n[backfill] Finished. Enriched {enriched:,}/{total:,} tracks "
            f"({len(failed_uris)} failed) in {elapsed:.1f}s.",
            flush=True,
        )
        if failed_uris:
            print(f"[backfill] Failed track URIs ({len(failed_uris)}):", flush=True)
            for u in failed_uris[:20]:
                print(f"  {u}", flush=True)
            if len(failed_uris) > 20:
                print(f"  ... and {len(failed_uris) - 20} more.", flush=True)

        print_verification(conn)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
