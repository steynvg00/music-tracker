"""Enrich tracks with metadata from Spotify's /tracks endpoint."""

import time

import spotipy


# Rows buffered across Spotify pages before one bulk write + commit.
# Deliberately decoupled from the /tracks page size: 50 is Spotify's hard API limit,
# the write batch size is ours to pick. Commits stay incremental (one per flush), so
# an interrupted backfill keeps everything already flushed — the checkpoint just moves
# from every 50 tracks to every 500.
WRITE_BATCH_SIZE = 500

_UPSERT_SQL = """
INSERT INTO track_metadata (
    track_uri, release_date, release_year, release_date_precision,
    duration_ms, popularity, explicit, album_id,
    artist_ids, artist_names, isrc, album_type, enriched_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
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
    isrc = EXCLUDED.isrc,
    album_type = EXCLUDED.album_type,
    enriched_at = NOW()
"""


def _flush(cur, conn, buffer: list[tuple]) -> tuple[int, float]:
    """Bulk-upsert the buffered rows, commit, and empty the buffer.

    De-duplicates on track_uri (tuple element 0) keeping the LAST occurrence, which is
    what the row-by-row loop effectively did: a repeated URI simply upserted twice and
    the later write won. enrich_tracks() takes an arbitrary caller-supplied URI list, so
    a duplicate inside a 500-row buffer is possible even though today's callers dedupe
    in SQL.

    Returns (rows written, seconds spent).
    """
    if not buffer:
        return 0, 0.0

    start = time.time()
    deduped = {row[0]: row for row in buffer}
    cur.executemany(_UPSERT_SQL, list(deduped.values()))
    conn.commit()
    buffer.clear()
    return len(deduped), time.time() - start


def enrich_tracks(sp, conn, track_uris: list[str]) -> dict:
    """Fetch metadata for the given track URIs from Spotify and UPSERT into track_metadata.

    Spotify's /tracks endpoint accepts comma-separated track IDs, up to 50 per call.
    Sleeps 1.1s between batches (rate-limit-safe); retries once after 60s on 429.
    Rows are buffered across pages and written WRITE_BATCH_SIZE at a time, one commit
    per flush.
    Returns a dict with summary stats.
    """
    start = time.time()

    if not track_uris:
        print("[track-meta] No tracks to enrich.", flush=True)
        return {
            "requested": 0,
            "enriched": 0,
            "failed": 0,
            "written": 0,
            "fetch_s": 0.0,
            "write_s": 0.0,
            "duration_s": 0.0,
        }

    # Strip "spotify:track:" prefix → bare IDs
    track_ids = [uri.replace("spotify:track:", "") for uri in track_uris]

    enriched = 0
    failed = 0
    written = 0
    fetch_s = 0.0
    write_s = 0.0
    pending: list[tuple] = []
    cur = conn.cursor()

    BATCH = 50
    total_batches = (len(track_ids) + BATCH - 1) // BATCH

    for i in range(0, len(track_ids), BATCH):
        batch = track_ids[i:i + BATCH]
        batch_num = i // BATCH + 1
        print(f"[track-meta] Batch {batch_num}/{total_batches} ({len(batch)} tracks)...", flush=True)

        if i > 0:
            time.sleep(1.1)

        fetch_start = time.time()
        for attempt in range(2):
            try:
                response = sp.tracks(batch)
                break
            except spotipy.exceptions.SpotifyException as e:
                if e.http_status == 429 and attempt == 0:
                    print("[track-meta] WARNING: 429 rate limit. Sleeping 60s before retry...", flush=True)
                    time.sleep(60)
                else:
                    raise
        fetch_s += time.time() - fetch_start

        tracks = response.get("tracks", []) or []

        for track in tracks:
            if track is None:
                # Spotify returns null for unavailable tracks (region-locked, deleted, etc.)
                failed += 1
                continue

            uri = track.get("uri")
            if not uri:
                failed += 1
                continue

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

            isrc = track.get("external_ids", {}).get("isrc") or None
            album_type = album.get("album_type") or None

            pending.append((
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
                isrc,
                album_type,
            ))
            enriched += 1

        if len(pending) >= WRITE_BATCH_SIZE:
            rows, elapsed = _flush(cur, conn, pending)
            written += rows
            write_s += elapsed

    # The last buffer is almost never a full WRITE_BATCH_SIZE — dropping it would be
    # silent data loss.
    rows, elapsed = _flush(cur, conn, pending)
    written += rows
    write_s += elapsed

    duration = time.time() - start
    print(f"[track-meta] Fetched {enriched} tracks in {fetch_s:.1f}s.", flush=True)
    print(f"[track-meta] Wrote {written} rows in {write_s:.1f}s.", flush=True)

    return {
        "requested": len(track_uris),
        "enriched": enriched,
        "failed": failed,
        "written": written,
        "fetch_s": fetch_s,
        "write_s": write_s,
        "duration_s": duration,
    }


def get_unenriched_played_track_uris(conn) -> list[str]:
    """Return distinct track_uris from spotify_plays that need enrichment.

    Covers two cases:
      1. No track_metadata row at all.
      2. Row exists but artist_ids is NULL (added in migration 0012).
    """
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
        """
    )
    return [row[0] for row in cur.fetchall()]
