CREATE TABLE IF NOT EXISTS artist_popularity_scores (
    artist_name        VARCHAR(500) PRIMARY KEY,
    total_plays        INTEGER      NOT NULL,
    sticky_raw         NUMERIC(10,4),
    sticky_pct         NUMERIC(5,4),
    evergreen_raw      NUMERIC(10,4),
    evergreen_pct      NUMERIC(5,4),
    depth_raw          INTEGER,
    depth_pct          NUMERIC(5,4),
    devotion_raw       NUMERIC(5,4),
    devotion_pct       NUMERIC(5,4),
    saved_count_raw    INTEGER,
    saved_count_pct    NUMERIC(5,4),
    composite_score    NUMERIC(5,4) NOT NULL,
    computed_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artist_popularity_composite
    ON artist_popularity_scores (composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_artist_popularity_sticky
    ON artist_popularity_scores (sticky_pct DESC);
