CREATE TABLE IF NOT EXISTS track_popularity_scores (
    track_uri          VARCHAR(50)  PRIMARY KEY,
    raw_plays          INTEGER      NOT NULL,
    sticky_raw         NUMERIC(10,4),
    sticky_pct         NUMERIC(5,4),
    evergreen_raw      NUMERIC(10,4),
    evergreen_pct      NUMERIC(5,4),
    flash_hit_raw      NUMERIC(10,4),
    flash_hit_pct      NUMERIC(5,4),
    session_loop_raw   NUMERIC(10,4),
    session_loop_pct   NUMERIC(5,4),
    composite_score    NUMERIC(5,4) NOT NULL,
    computed_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_track_popularity_composite
    ON track_popularity_scores (composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_track_popularity_sticky
    ON track_popularity_scores (sticky_pct DESC);
