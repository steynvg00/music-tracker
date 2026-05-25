"""Compute and store normalized popularity scores for tracks with 20+ plays.

v0.58: plays are now aggregated by canonical_track_uri (via track_metadata)
so that duplicate URIs for the same recording (single vs. album release, same
ISRC) contribute to a single row instead of splitting plays across two rows.
"""

import time

from lib.popularity_config import (
    MIN_PLAYS_FOR_TRACK_SCORING,
    TRACK_COMPOSITE_WEIGHTS,
    TRACK_FLASH_HIT_RATIO_THRESHOLD,
    TRACK_FLASH_HIT_WINDOW_DAYS,
    TRACK_SESSION_WINDOW_HOURS,
    TRACK_STICKY_WINDOW_DAYS,
)

MIN_PLAYS_FOR_SCORING = MIN_PLAYS_FOR_TRACK_SCORING  # backward-compat alias for scripts

_W = TRACK_COMPOSITE_WEIGHTS

_INSERT_SQL = f"""
WITH plays_by_canonical AS (
    SELECT
        tm.canonical_track_uri AS track_uri,
        sp.played_at,
        sp.ms_played,
        sp.reason_end
    FROM spotify_plays sp
    JOIN track_metadata tm ON tm.track_uri = sp.track_uri
    WHERE sp.track_uri IS NOT NULL
      AND tm.canonical_track_uri IS NOT NULL
),
track_basics AS (
    SELECT track_uri, COUNT(*) AS total_plays, MIN(played_at) AS first_played
    FROM plays_by_canonical
    GROUP BY track_uri
    HAVING COUNT(*) >= {MIN_PLAYS_FOR_TRACK_SCORING}
),
sticky_calc AS (
    SELECT tb.track_uri, tb.total_plays,
        COUNT(*) FILTER (WHERE pbc.played_at >= NOW() - INTERVAL '{TRACK_STICKY_WINDOW_DAYS} days') AS plays_last_90d,
        LEAST(
            COUNT(*) FILTER (WHERE pbc.played_at >= NOW() - INTERVAL '{TRACK_STICKY_WINDOW_DAYS} days') / 30.0,
            1.0
        ) * SQRT(tb.total_plays) AS sticky_raw
    FROM track_basics tb
    JOIN plays_by_canonical pbc USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays
),
evergreen_calc AS (
    SELECT tb.track_uri,
        (COUNT(DISTINCT DATE_TRUNC('month', pbc.played_at))::FLOAT /
         GREATEST(
             EXTRACT(YEAR FROM AGE(NOW(), tb.first_played))::INT * 12 +
             EXTRACT(MONTH FROM AGE(NOW(), tb.first_played))::INT + 1,
             1
         )
        ) * SQRT(tb.total_plays) AS evergreen_raw
    FROM track_basics tb
    JOIN plays_by_canonical pbc USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays, tb.first_played
),
play_windows AS (
    SELECT track_uri, played_at,
        COUNT(*) OVER (
            PARTITION BY track_uri ORDER BY played_at
            RANGE BETWEEN INTERVAL '{TRACK_FLASH_HIT_WINDOW_DAYS} days' PRECEDING AND CURRENT ROW
        ) AS plays_in_window
    FROM plays_by_canonical
    WHERE track_uri IN (SELECT track_uri FROM track_basics)
),
flash_hit_calc AS (
    SELECT tb.track_uri,
        MAX(pw.plays_in_window)::FLOAT / tb.total_plays AS window_share,
        CASE
            WHEN MAX(pw.plays_in_window)::FLOAT / tb.total_plays > {TRACK_FLASH_HIT_RATIO_THRESHOLD} THEN
                (MAX(pw.plays_in_window)::FLOAT / tb.total_plays - {TRACK_FLASH_HIT_RATIO_THRESHOLD}) * 2 * LN(tb.total_plays)
            ELSE 0
        END AS flash_hit_raw
    FROM track_basics tb
    JOIN play_windows pw USING (track_uri)
    GROUP BY tb.track_uri, tb.total_plays
),
session_gaps AS (
    SELECT track_uri, played_at,
        LAG(played_at) OVER (PARTITION BY track_uri ORDER BY played_at) AS prev_played_at
    FROM plays_by_canonical
    WHERE track_uri IN (SELECT track_uri FROM track_basics)
),
session_loop_calc AS (
    SELECT tb.track_uri,
        COUNT(*) FILTER (
            WHERE sg.prev_played_at IS NOT NULL
            AND sg.played_at - sg.prev_played_at < INTERVAL '{TRACK_SESSION_WINDOW_HOURS} hours'
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
        sticky_raw,      PERCENT_RANK() OVER (ORDER BY sticky_raw NULLS FIRST)      AS sticky_pct,
        evergreen_raw,   PERCENT_RANK() OVER (ORDER BY evergreen_raw NULLS FIRST)   AS evergreen_pct,
        flash_hit_raw,   PERCENT_RANK() OVER (ORDER BY flash_hit_raw NULLS FIRST)   AS flash_hit_pct,
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
    {_W['plays_log_pct']} * plays_log_pct
    + {_W['sticky']} * COALESCE(sticky_pct, 0)
    + {_W['evergreen']} * COALESCE(evergreen_pct, 0)
    + {_W['flash_hit']} * COALESCE(flash_hit_pct, 0)
    + {_W['session_loop']} * COALESCE(session_loop_pct, 0)
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

_TOP10_SQL = """
SELECT
    s.track_uri,
    s.composite_score,
    COALESCE(
        (SELECT MAX(sp.track_name) FROM spotify_plays sp WHERE sp.track_uri = s.track_uri),
        '?'
    ) AS track_name,
    COALESCE(
        array_to_string(
            (SELECT tm.artist_names FROM track_metadata tm WHERE tm.track_uri = s.track_uri),
            ', '
        ),
        (SELECT MAX(sp.artist_name) FROM spotify_plays sp WHERE sp.track_uri = s.track_uri),
        '?'
    ) AS artist_name
FROM track_popularity_scores s
ORDER BY s.composite_score DESC
LIMIT 10
"""


def compute_and_store_scores(conn) -> dict:
    """Run the full scoring pipeline and store results in track_popularity_scores.

    Transaction: TRUNCATE + INSERT in one atomic operation so a mid-run failure
    never leaves the table empty. Returns stats dict including before/after counts.
    """
    start = time.time()
    cur = conn.cursor()

    try:
        # Capture state before truncate
        cur.execute("SELECT COUNT(*) FROM track_popularity_scores")
        before_count = cur.fetchone()[0]
        cur.execute(_TOP10_SQL)
        before_top10 = cur.fetchall()

        # TRUNCATE removes stale per-URI rows; INSERT replaces with canonical-URI rows.
        cur.execute("TRUNCATE TABLE track_popularity_scores")
        cur.execute(_INSERT_SQL)
        total_inserted = cur.rowcount

        cur.execute("SELECT COUNT(*) FROM track_popularity_scores")
        after_count = cur.fetchone()[0]
        cur.execute(_TOP10_SQL)
        after_top10 = cur.fetchall()

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()

    runtime = time.time() - start

    print("\n=== Before v0.58 (Top 10 composite) ===", flush=True)
    for i, (uri, score, track_name, artist_name) in enumerate(before_top10, 1):
        print(f"{i:2}. {artist_name} - {track_name}  {float(score):.4f}", flush=True)
    if not before_top10:
        print("  (table was empty)", flush=True)

    print("\n=== After v0.58 (Top 10 composite) ===", flush=True)
    for i, (uri, score, track_name, artist_name) in enumerate(after_top10, 1):
        print(f"{i:2}. {artist_name} - {track_name}  {float(score):.4f}", flush=True)

    print(f"\nTotal tracks scored: {after_count:,} (was {before_count:,})", flush=True)

    print(
        f"[track-popularity] Done. Truncated {before_count} old rows, "
        f"inserted {total_inserted} new rows in {runtime:.1f}s.",
        flush=True,
    )

    return {
        "rows_inserted": total_inserted,
        "rows_updated": 0,
        "runtime_seconds": runtime,
        "before_count": before_count,
        "after_count": after_count,
    }


def get_scores(conn, track_uri: str) -> dict | None:
    """Fetch the popularity score row for a track, or None if not scored.

    Note: after v0.58 the table is keyed by canonical_track_uri. Passing a
    non-canonical URI will return None until v0.59 resolves the lookup.
    """
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
