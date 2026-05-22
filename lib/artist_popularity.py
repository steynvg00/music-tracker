"""Compute and store normalized popularity scores for artists with 100+ plays.

v0.54: attribution now uses track_metadata.artist_names (Spotify's authoritative
artists array) via UNNEST, so every credited artist on a collab track receives
the play. Previously grouped by spotify_plays.artist_name (credit string only).
"""

import time

from lib.popularity_config import (
    ARTIST_COMPOSITE_WEIGHTS,
    ARTIST_DEPTH_MIN_PLAYS_PER_TRACK,
    ARTIST_STICKY_WINDOW_DAYS,
    MIN_PLAYS_FOR_ARTIST_SCORING,
)

_W = ARTIST_COMPOSITE_WEIGHTS

_INSERT_SQL = f"""
WITH plays_with_artists AS (
    SELECT
        sp.track_uri,
        sp.played_at,
        sp.ms_played,
        UNNEST(tm.artist_names) AS artist_name
    FROM spotify_plays sp
    JOIN track_metadata tm ON tm.track_uri = sp.track_uri
    WHERE sp.track_uri IS NOT NULL
      AND tm.artist_names IS NOT NULL
      AND array_length(tm.artist_names, 1) > 0
),
artist_basics AS (
    SELECT artist_name,
           COUNT(*) AS total_plays,
           MIN(played_at) AS first_played
    FROM plays_with_artists
    GROUP BY artist_name
    HAVING COUNT(*) >= {MIN_PLAYS_FOR_ARTIST_SCORING}
),
sticky_calc AS (
    SELECT ab.artist_name, ab.total_plays,
           COUNT(*) FILTER (WHERE pwa.played_at >= NOW() - INTERVAL '{ARTIST_STICKY_WINDOW_DAYS} days')::FLOAT
               / NULLIF(ab.total_plays, 0) AS sticky_raw
    FROM artist_basics ab
    JOIN plays_with_artists pwa ON pwa.artist_name = ab.artist_name
    GROUP BY ab.artist_name, ab.total_plays
),
evergreen_calc AS (
    SELECT ab.artist_name,
        COUNT(DISTINCT DATE_TRUNC('month', pwa.played_at)) AS evergreen_raw
    FROM artist_basics ab
    JOIN plays_with_artists pwa ON pwa.artist_name = ab.artist_name
    GROUP BY ab.artist_name, ab.total_plays, ab.first_played
),
track_plays_per_artist AS (
    SELECT artist_name, track_uri, COUNT(*) AS plays
    FROM plays_with_artists
    WHERE artist_name IN (SELECT artist_name FROM artist_basics)
    GROUP BY artist_name, track_uri
),
depth_calc AS (
    SELECT artist_name,
           COUNT(*) FILTER (WHERE plays >= {ARTIST_DEPTH_MIN_PLAYS_PER_TRACK}) AS depth_raw
    FROM track_plays_per_artist
    GROUP BY artist_name
),
devotion_calc AS (
    SELECT artist_name,
           MAX(plays)::FLOAT / SUM(plays) AS devotion_raw
    FROM track_plays_per_artist
    GROUP BY artist_name
),
liked_with_artists AS (
    SELECT
        ls.track_uri,
        UNNEST(tm.artist_names) AS artist_name
    FROM liked_songs ls
    JOIN track_metadata tm ON tm.track_uri = ls.track_uri
    WHERE tm.artist_names IS NOT NULL
      AND array_length(tm.artist_names, 1) > 0
),
saved_count_calc AS (
    SELECT
        artist_name,
        COUNT(DISTINCT track_uri) AS saved_count
    FROM liked_with_artists
    GROUP BY artist_name
),
raw_combined AS (
    SELECT ab.artist_name, ab.total_plays,
        s.sticky_raw, e.evergreen_raw, d.depth_raw, dv.devotion_raw,
        COALESCE(sc.saved_count, 0) AS saved_count_raw
    FROM artist_basics ab
    LEFT JOIN sticky_calc s USING (artist_name)
    LEFT JOIN evergreen_calc e USING (artist_name)
    LEFT JOIN depth_calc d USING (artist_name)
    LEFT JOIN devotion_calc dv USING (artist_name)
    LEFT JOIN saved_count_calc sc USING (artist_name)
),
percentile_ranks AS (
    SELECT artist_name, total_plays,
        sticky_raw,      PERCENT_RANK() OVER (ORDER BY sticky_raw NULLS FIRST)      AS sticky_pct,
        evergreen_raw,   PERCENT_RANK() OVER (ORDER BY evergreen_raw NULLS FIRST)   AS evergreen_pct,
        depth_raw,       PERCENT_RANK() OVER (ORDER BY depth_raw NULLS FIRST)       AS depth_pct,
        devotion_raw,    PERCENT_RANK() OVER (ORDER BY devotion_raw NULLS FIRST)    AS devotion_pct,
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
    {_W['plays_log_pct']} * plays_log_pct
    + {_W['sticky']} * COALESCE(sticky_pct, 0)
    + {_W['evergreen']} * COALESCE(evergreen_pct, 0)
    + {_W['depth']} * COALESCE(depth_pct, 0)
    + {_W['saved']} * COALESCE(saved_count_pct, 0)
    + {_W['devotion']} * (1.0 - COALESCE(devotion_pct, 0))
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

_TOP10_SQL = (
    "SELECT artist_name, composite_score "
    "FROM artist_popularity_scores "
    "ORDER BY composite_score DESC LIMIT 10"
)


def compute_and_store_scores(conn) -> dict:
    """Run the full artist scoring pipeline and store results in artist_popularity_scores.

    Transaction: TRUNCATE + INSERT in one atomic operation so a mid-run failure
    never leaves the table empty.
    Returns stats dict including before/after Top 10 for the verification log.
    """
    start = time.time()
    cur = conn.cursor()

    try:
        # Capture state before truncate (may be empty on first ever run)
        cur.execute("SELECT COUNT(*) FROM artist_popularity_scores")
        before_count = cur.fetchone()[0]

        cur.execute(_TOP10_SQL)
        before_top10 = cur.fetchall()

        # TRUNCATE removes stale credit-string-keyed rows; INSERT replaces with
        # canonical-name-keyed rows from the artist_names array.
        cur.execute("TRUNCATE TABLE artist_popularity_scores")
        cur.execute(_INSERT_SQL)
        total_inserted = cur.rowcount

        cur.execute("SELECT COUNT(*) FROM artist_popularity_scores")
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

    print("\n=== Before v0.54 (Top 10 composite) ===", flush=True)
    for i, (name, score) in enumerate(before_top10, 1):
        print(f"{i:2}. {name}  {float(score):.4f}", flush=True)
    if not before_top10:
        print("  (table was empty)", flush=True)

    print("\n=== After v0.54 (Top 10 composite) ===", flush=True)
    for i, (name, score) in enumerate(after_top10, 1):
        print(f"{i:2}. {name}  {float(score):.4f}", flush=True)

    print(f"\nTotal artists scored: {after_count:,} (was {before_count:,})", flush=True)

    print(
        f"[artist-popularity] Done. Truncated {before_count} old rows, "
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


def rank_artists_by_composite(conn, artist_names: list[str]) -> list[str]:
    """Rank a set of artist names by composite popularity score.

    Drop-in replacement for rank_artists_by_plays. Returns the input list
    sorted by composite_score DESC. Artists without a row in
    artist_popularity_scores (i.e. fewer than 100 plays) are sorted to the
    end of the list, ordered among themselves by raw plays DESC (fallback
    to the play-based ranker for the unscored tail).
    """
    if not artist_names:
        return []

    from lib.missed_new_tracks import rank_artists_by_plays

    cur = conn.cursor()
    cur.execute(
        "SELECT artist_name, composite_score FROM artist_popularity_scores WHERE artist_name = ANY(%s)",
        (artist_names,),
    )
    rows = cur.fetchall()
    cur.close()

    scored = {row[0]: float(row[1]) for row in rows}
    scored_names = sorted(scored, key=lambda n: scored[n], reverse=True)
    unscored_names = [n for n in artist_names if n not in scored]
    unscored_ranked = rank_artists_by_plays(conn, unscored_names)

    return scored_names + unscored_ranked
