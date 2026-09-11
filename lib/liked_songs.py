"""Sync Spotify Liked Songs (/me/tracks) into the liked_songs table."""

import psycopg

# Rows streamed into the COPY buffer between progress log lines.
COPY_LOG_EVERY = 2000


def sync_liked_songs(sp, conn) -> dict:
    """Fetch all liked songs from Spotify and atomically replace the liked_songs table.

    Returns a dict with summary stats:
    {'fetched': int, 'inserted': int, 'fetch_s': float, 'write_s': float, 'duration_s': float}.
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
    fetch_duration = time.time() - start
    print(f"[liked-songs] Fetched {fetched} songs in {fetch_duration:.1f}s.", flush=True)

    # Flatten to the exact column tuple the table expects, skipping unusable items.
    # seq preserves fetch order so the staging de-dup below keeps the last occurrence
    # of a track_uri, matching the previous row-by-row upsert semantics.
    rows = []
    for item in all_items:
        track = item.get("track")
        if not track or not track.get("uri"):
            continue
        rows.append((
            len(rows),
            track["uri"],
            item.get("added_at"),
            track.get("name"),
            ", ".join(a.get("name", "") for a in track.get("artists", [])),
            (track.get("album") or {}).get("name"),
        ))

    write_start = time.time()

    # Atomic replace: stage via COPY, then DELETE + INSERT in one transaction.
    # If anything raises, the transaction rolls back and the previous snapshot stands.
    with conn.transaction():
        cur = conn.cursor()

        # Staging table has no PRIMARY KEY on purpose: Spotify can hand back the same
        # track twice if the library changes mid-pagination, and COPY cannot upsert.
        cur.execute(
            """
            CREATE TEMP TABLE liked_songs_stage (
                seq         BIGINT,
                track_uri   TEXT,
                liked_at    TIMESTAMPTZ,
                track_name  TEXT,
                artist_name TEXT,
                album_name  TEXT
            ) ON COMMIT DROP
            """
        )

        with cur.copy(
            "COPY liked_songs_stage "
            "(seq, track_uri, liked_at, track_name, artist_name, album_name) FROM STDIN"
        ) as copy:
            for i, row in enumerate(rows, start=1):
                copy.write_row(row)
                if i % COPY_LOG_EVERY == 0:
                    print(f"[liked-songs] Staged {i}/{len(rows)} rows...", flush=True)

        cur.execute("DELETE FROM liked_songs")
        cur.execute(
            """
            INSERT INTO liked_songs (track_uri, liked_at, track_name, artist_name, album_name)
            SELECT DISTINCT ON (track_uri)
                   track_uri, liked_at, track_name, artist_name, album_name
            FROM liked_songs_stage
            ORDER BY track_uri, seq DESC
            ON CONFLICT (track_uri) DO UPDATE SET
                liked_at = EXCLUDED.liked_at,
                track_name = EXCLUDED.track_name,
                artist_name = EXCLUDED.artist_name,
                album_name = EXCLUDED.album_name,
                synced_at = NOW()
            """
        )
        inserted = cur.rowcount

    write_duration = time.time() - write_start
    print(f"[liked-songs] Wrote {inserted} rows in {write_duration:.1f}s.", flush=True)

    duration = time.time() - start

    return {
        "fetched": fetched,
        "inserted": inserted,
        "fetch_s": fetch_duration,
        "write_s": write_duration,
        "duration_s": duration,
    }
