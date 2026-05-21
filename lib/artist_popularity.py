"""Compute and store normalized popularity scores for artists with 100+ plays."""

import time

MIN_PLAYS_FOR_ARTIST_SCORING = 100

_UPSERT_SQL = """
WITH artist_basics AS (
    SELECT artist_name,
           COUNT(*) AS total_plays,
           MIN(played_at) AS first_played
    FROM spotify_plays
    WHERE artist_name IS NOT NULL AND track_uri IS NOT NULL
    GROUP BY artist_name
    HAVING COUNT(*) >= 100
),
sticky_calc AS (
    SELECT ab.artist_name, ab.total_plays,
           COUNT(sp.*) FILTER (WHERE sp.played_at >= NOW() - INTERVAL '90 days')::FLOAT / NULLIF(ab.total_plays, 0) AS sticky_raw
    FROM artist_basics ab
    JOIN spotify_plays sp USING (artist_name)
    WHERE sp.track_uri IS NOT NULL
    GROUP BY ab.artist_name, ab.total_plays
),
evergreen_calc AS (
    SELECT ab.artist_name,
        COUNT(DISTINCT DATE_TRUNC('month', sp.played_at)) AS evergreen_raw
    FROM artist_basics ab
    JOIN spotify_plays sp USING (artist_name)
    WHERE sp.track_uri IS NOT NULL
    GROUP BY ab.artist_name, ab.total_plays, ab.first_played
),
track_plays_per_artist AS (
    SELECT artist_name, track_uri, COUNT(*) AS plays
    FROM spotify_plays
    WHERE artist_name IS NOT NULL AND track_uri IS NOT NULL
      AND artist_name IN (SELECT artist_name FROM artist_basics)
    GROUP BY artist_name, track_uri
),
depth_calc AS (
    SELECT artist_name,
           COUNT(*) FILTER (WHERE plays >= 5) AS depth_raw
    FROM track_plays_per_artist
    GROUP BY artist_name
),
devotion_calc AS (
    SELECT artist_name,
           MAX(plays)::FLOAT / SUM(plays) AS devotion_raw
    FROM track_plays_per_artist
    GROUP BY artist_name
),
artist_track_map AS (
    SELECT DISTINCT artist_name, track_uri
    FROM spotify_plays
    WHERE artist_name IS NOT NULL AND track_uri IS NOT NULL
      AND artist_name IN (SELECT artist_name FROM artist_basics)
),
saved_count_calc AS (
    SELECT atm.artist_name,
           COUNT(DISTINCT ls.track_uri) AS saved_count_raw
    FROM liked_songs ls
    JOIN artist_track_map atm USING (track_uri)
    GROUP BY atm.artist_name
),
raw_combined AS (
    SELECT ab.artist_name, ab.total_plays,
        s.sticky_raw, e.evergreen_raw, d.depth_raw, dv.devotion_raw,
        COALESCE(sc.saved_count_raw, 0) AS saved_count_raw
    FROM artist_basics ab
    LEFT JOIN sticky_calc s USING (artist_name)
    LEFT JOIN evergreen_calc e USING (artist_name)
    LEFT JOIN depth_calc d USING (artist_name)
    LEFT JOIN devotion_calc dv USING (artist_name)
    LEFT JOIN saved_count_calc sc USING (artist_name)
),
percentile_ranks AS (
    SELECT artist_name, total_plays,
        sticky_raw, PERCENT_RANK() OVER (ORDER BY sticky_raw NULLS FIRST) AS sticky_pct,
        evergreen_raw, PERCENT_RANK() OVER (ORDER BY evergreen_raw NULLS FIRST) AS evergreen_pct,
        depth_raw, PERCENT_RANK() OVER (ORDER BY depth_raw NULLS FIRST) AS depth_pct,
        devotion_raw, PERCENT_RANK() OVER (ORDER BY devotion_raw NULLS FIRST) AS devotion_pct,
        saved_count_raw, PERCENT_RANK() OVER (ORDER BY saved_count_raw NULLS FIRST) AS saved_count_pct,
        PERCENT_RANK() OVER (ORDER BY LN(total_plays)) AS plays_log_pct
    FROM raw_combined
)
INSERT INTO artist_popularity_scores (
    artist_name, total_plays,
    sticky_raw, sticky_pct,
    evergreen_raw, evergreen_pct,
    depth_raw, depth_pct,
    devotion_raw, devotion_pct,
    saved_count_raw, saved_count_pct,
    composite_score, computed_at
)
SELECT
    artist_name, total_plays,
    sticky_raw, sticky_pct,
    evergreen_raw, evergreen_pct,
    depth_raw, depth_pct,
    devotion_raw, devotion_pct,
    saved_count_raw, saved_count_pct,
    0.30 * plays_log_pct
    + 0.20 * COALESCE(sticky_pct, 0)
    + 0.20 * COALESCE(evergreen_pct, 0)
    + 0.10 * COALESCE(depth_pct, 0)
    + 0.10 * COALESCE(saved_count_pct, 0)
    + 0.10 * (1.0 - COALESCE(devotion_pct, 0))
        AS composite_score,
    NOW()
FROM percentile_ranks
ON CONFLICT (artist_name) DO UPDATE SET
    total_plays      = EXCLUDED.total_plays,
    sticky_raw       = EXCLUDED.sticky_raw,       sticky_pct       = EXCLUDED.sticky_pct,
    evergreen_raw    = EXCLUDED.evergreen_raw,    evergreen_pct    = EXCLUDED.evergreen_pct,
    depth_raw        = EXCLUDED.depth_raw,        depth_pct        = EXCLUDED.depth_pct,
    devotion_raw     = EXCLUDED.devotion_raw,     devotion_pct     = EXCLUDED.devotion_pct,
    saved_count_raw  = EXCLUDED.saved_count_raw,  saved_count_pct  = EXCLUDED.saved_count_pct,
    composite_score  = EXCLUDED.composite_score,
    computed_at      = NOW()
"""


def compute_and_store_scores(conn) -> dict:
    """Run the full artist scoring pipeline and upsert into artist_popularity_scores.

    Wrapped in a transaction — rolls back on failure.
    Returns: {rows_inserted: int, rows_updated: int, runtime_seconds: float}
    """
    start = time.time()
    cur = conn.cursor()

    try:
        cur.execute("SELECT COUNT(*) FROM artist_popularity_scores")
        before_count = cur.fetchone()[0]

        cur.execute(_UPSERT_SQL)
        total_processed = cur.rowcount

        cur.execute("SELECT COUNT(*) FROM artist_popularity_scores")
        after_count = cur.fetchone()[0]

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()

    rows_inserted = after_count - before_count
    rows_updated = total_processed - rows_inserted
    runtime = time.time() - start

    print(
        f"[artist-popularity] Done. Processed {total_processed} artists "
        f"({rows_inserted} inserted, {rows_updated} updated) in {runtime:.1f}s.",
        flush=True,
    )

    return {
        "rows_inserted": rows_inserted,
        "rows_updated": rows_updated,
        "runtime_seconds": runtime,
    }


def get_scores(conn, artist_name: str) -> dict | None:
    """Fetch the popularity score row for an artist, or None if not scored."""
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM artist_popularity_scores WHERE artist_name = %s",
        (artist_name,),
    )
    row = cur.fetchone()
    if row is None:
        cur.close()
        return None
    columns = [desc[0] for desc in cur.description]
    cur.close()
    return dict(zip(columns, row))
