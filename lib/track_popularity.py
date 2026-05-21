"""Compute and store normalized popularity scores for tracks with 20+ plays."""

import time

MIN_PLAYS_FOR_SCORING = 20

_UPSERT_SQL = """
WITH track_basics AS (
    SELECT track_uri, COUNT(*) AS total_plays, MIN(played_at) AS first_played
    FROM spotify_plays
    WHERE track_uri IS NOT NULL
    GROUP BY track_uri
    HAVING COUNT(*) >= 20
),
sticky_calc AS (
    SELECT tb.track_uri, tb.total_plays,
        COUNT(sp.*) FILTER (WHERE sp.played_at >= NOW() - INTERVAL '90 days') AS plays_last_90d,
        LEAST(
            COUNT(sp.*) FILTER (WHERE sp.played_at >= NOW() - INTERVAL '90 days') / 30.0,
            1.0
        ) * SQRT(tb.total_plays) AS sticky_raw
    FROM track_basics tb
    JOIN spotify_plays sp USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays
),
evergreen_calc AS (
    SELECT tb.track_uri,
        (COUNT(DISTINCT DATE_TRUNC('month', sp.played_at))::FLOAT /
         GREATEST(
             EXTRACT(YEAR FROM AGE(NOW(), tb.first_played))::INT * 12 +
             EXTRACT(MONTH FROM AGE(NOW(), tb.first_played))::INT + 1,
             1
         )
        ) * SQRT(tb.total_plays) AS evergreen_raw
    FROM track_basics tb
    JOIN spotify_plays sp USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays, tb.first_played
),
play_windows AS (
    SELECT track_uri, played_at,
        COUNT(*) OVER (
            PARTITION BY track_uri ORDER BY played_at
            RANGE BETWEEN INTERVAL '90 days' PRECEDING AND CURRENT ROW
        ) AS plays_in_window
    FROM spotify_plays
    WHERE track_uri IN (SELECT track_uri FROM track_basics)
),
flash_hit_calc AS (
    SELECT tb.track_uri,
        MAX(pw.plays_in_window)::FLOAT / tb.total_plays AS window_share,
        CASE
            WHEN MAX(pw.plays_in_window)::FLOAT / tb.total_plays > 0.5 THEN
                (MAX(pw.plays_in_window)::FLOAT / tb.total_plays - 0.5) * 2 * LN(tb.total_plays)
            ELSE 0
        END AS flash_hit_raw
    FROM track_basics tb
    JOIN play_windows pw USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays
),
session_gaps AS (
    SELECT track_uri, played_at,
        LAG(played_at) OVER (PARTITION BY track_uri ORDER BY played_at) AS prev_played_at
    FROM spotify_plays
    WHERE track_uri IN (SELECT track_uri FROM track_basics)
),
session_loop_calc AS (
    SELECT tb.track_uri,
        COUNT(*) FILTER (
            WHERE sg.prev_played_at IS NOT NULL
            AND sg.played_at - sg.prev_played_at < INTERVAL '2 hours'
        )::FLOAT / tb.total_plays AS session_loop_raw
    FROM track_basics tb
    JOIN session_gaps sg USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays
),
raw_combined AS (
    SELECT tb.track_uri, tb.total_plays,
        s.sticky_raw, e.evergreen_raw, f.flash_hit_raw, sl.session_loop_raw
    FROM track_basics tb
    LEFT JOIN sticky_calc s USING (track_uri)
    LEFT JOIN evergreen_calc e USING (track_uri)
    LEFT JOIN flash_hit_calc f USING (track_uri)
    LEFT JOIN session_loop_calc sl USING (track_uri)
),
percentile_ranks AS (
    SELECT track_uri, total_plays,
        sticky_raw, PERCENT_RANK() OVER (ORDER BY sticky_raw NULLS FIRST) AS sticky_pct,
        evergreen_raw, PERCENT_RANK() OVER (ORDER BY evergreen_raw NULLS FIRST) AS evergreen_pct,
        flash_hit_raw, PERCENT_RANK() OVER (ORDER BY flash_hit_raw NULLS FIRST) AS flash_hit_pct,
        session_loop_raw, PERCENT_RANK() OVER (ORDER BY session_loop_raw NULLS FIRST) AS session_loop_pct,
        PERCENT_RANK() OVER (ORDER BY LN(total_plays)) AS plays_log_pct
    FROM raw_combined
)
INSERT INTO track_popularity_scores (
    track_uri, raw_plays,
    sticky_raw, sticky_pct,
    evergreen_raw, evergreen_pct,
    flash_hit_raw, flash_hit_pct,
    session_loop_raw, session_loop_pct,
    composite_score, computed_at
)
SELECT
    track_uri, total_plays,
    sticky_raw, sticky_pct,
    evergreen_raw, evergreen_pct,
    flash_hit_raw, flash_hit_pct,
    session_loop_raw, session_loop_pct,
    0.4 * plays_log_pct
    + 0.2 * COALESCE(sticky_pct, 0)
    + 0.2 * COALESCE(evergreen_pct, 0)
    + 0.1 * COALESCE(flash_hit_pct, 0)
    + 0.1 * COALESCE(session_loop_pct, 0)
        AS composite_score,
    NOW()
FROM percentile_ranks
ON CONFLICT (track_uri) DO UPDATE SET
    raw_plays        = EXCLUDED.raw_plays,
    sticky_raw       = EXCLUDED.sticky_raw,       sticky_pct       = EXCLUDED.sticky_pct,
    evergreen_raw    = EXCLUDED.evergreen_raw,    evergreen_pct    = EXCLUDED.evergreen_pct,
    flash_hit_raw    = EXCLUDED.flash_hit_raw,    flash_hit_pct    = EXCLUDED.flash_hit_pct,
    session_loop_raw = EXCLUDED.session_loop_raw, session_loop_pct = EXCLUDED.session_loop_pct,
    composite_score  = EXCLUDED.composite_score,
    computed_at      = NOW()
"""


def compute_and_store_scores(conn) -> dict:
    """Run the full scoring pipeline and upsert results into track_popularity_scores.

    Wrapped in a transaction — rolls back on failure.
    Returns: {rows_inserted: int, rows_updated: int, runtime_seconds: float}
    """
    start = time.time()
    cur = conn.cursor()

    try:
        cur.execute("SELECT COUNT(*) FROM track_popularity_scores")
        before_count = cur.fetchone()[0]

        cur.execute(_UPSERT_SQL)
        total_processed = cur.rowcount

        cur.execute("SELECT COUNT(*) FROM track_popularity_scores")
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
        f"[track-popularity] Done. Processed {total_processed} tracks "
        f"({rows_inserted} inserted, {rows_updated} updated) in {runtime:.1f}s.",
        flush=True,
    )

    return {
        "rows_inserted": rows_inserted,
        "rows_updated": rows_updated,
        "runtime_seconds": runtime,
    }


def get_scores(conn, track_uri: str) -> dict | None:
    """Fetch the popularity score row for a track, or None if not scored."""
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM track_popularity_scores WHERE track_uri = %s",
        (track_uri,),
    )
    row = cur.fetchone()
    if row is None:
        cur.close()
        return None
    columns = [desc[0] for desc in cur.description]
    cur.close()
    return dict(zip(columns, row))
