"""Enrich tracks with metadata from Spotify's /tracks endpoint."""

import time


def enrich_tracks(sp, conn, track_uris: list[str]) -> dict:
    """Fetch metadata for the given track URIs from Spotify and UPSERT into track_metadata.

    Spotify's /tracks endpoint accepts comma-separated track IDs, up to 50 per call.
    Returns a dict with summary stats: {'requested': int, 'enriched': int, 'failed': int, 'duration_s': float}.
    """
    start = time.time()

    if not track_uris:
        print("[track-meta] No tracks to enrich.", flush=True)
        return {"requested": 0, "enriched": 0, "failed": 0, "duration_s": 0.0}

    # Strip "spotify:track:" prefix → bare IDs
    track_ids = [uri.replace("spotify:track:", "") for uri in track_uris]

    enriched = 0
    failed = 0
    cur = conn.cursor()

    BATCH = 50
    total_batches = (len(track_ids) + BATCH - 1) // BATCH

    for i in range(0, len(track_ids), BATCH):
        batch = track_ids[i:i + BATCH]
        batch_num = i // BATCH + 1
        print(f"[track-meta] Batch {batch_num}/{total_batches} ({len(batch)} tracks)...", flush=True)

        response = sp.tracks(batch)
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
            enriched += 1

        conn.commit()

    duration = time.time() - start
    print(f"[track-meta] Done. Requested {len(track_uris)}, enriched {enriched}, failed {failed} in {duration:.1f}s.", flush=True)

    return {
        "requested": len(track_uris),
        "enriched": enriched,
        "failed": failed,
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
