"""Sync Spotify Liked Songs (/me/tracks) into the liked_songs table."""

import psycopg


def sync_liked_songs(sp, conn) -> dict:
    """Fetch all liked songs from Spotify and atomically replace the liked_songs table.

    Returns a dict with summary stats: {'fetched': int, 'inserted': int, 'duration_s': float}.
    """
    import time
    start = time.time()

    # Paginate through /me/tracks (50 per page, no hard limit)
    all_items = []
    offset = 0
    while True:
        print(f"[liked-songs] Fetching page at offset {offset}...", flush=True)
        page = sp.current_user_saved_tracks(limit=50, offset=offset)
        items = page.get("items", [])
        if not items:
            break
        all_items.extend(items)
        if len(items) < 50:
            break
        offset += 50

    fetched = len(all_items)
    print(f"[liked-songs] Fetched {fetched} liked songs from Spotify.", flush=True)

    # Atomic replace: DELETE + INSERT in one transaction
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("DELETE FROM liked_songs")
        for item in all_items:
            track = item.get("track")
            if not track or not track.get("uri"):
                continue
            cur.execute(
                """
                INSERT INTO liked_songs (track_uri, liked_at, track_name, artist_name, album_name)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (track_uri) DO UPDATE SET
                    liked_at = EXCLUDED.liked_at,
                    track_name = EXCLUDED.track_name,
                    artist_name = EXCLUDED.artist_name,
                    album_name = EXCLUDED.album_name,
                    synced_at = NOW()
                """,
                (
                    track["uri"],
                    item.get("added_at"),
                    track.get("name"),
                    ", ".join(a.get("name", "") for a in track.get("artists", [])),
                    (track.get("album") or {}).get("name"),
                ),
            )

    duration = time.time() - start
    print(f"[liked-songs] Replace complete. {fetched} rows in {duration:.1f}s.", flush=True)

    return {"fetched": fetched, "inserted": fetched, "duration_s": duration}
