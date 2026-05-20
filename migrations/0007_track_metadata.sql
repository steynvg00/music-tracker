-- 0007: track_metadata table for Spotify track details (/tracks endpoint)
CREATE TABLE IF NOT EXISTS track_metadata (
    track_uri               TEXT PRIMARY KEY,
    release_date            TEXT,         -- raw from API: "2024", "2024-03", or "2024-03-15"
    release_year            INTEGER,
    release_date_precision  TEXT,         -- "year" | "month" | "day"
    duration_ms             INTEGER,
    popularity              INTEGER,
    explicit                BOOLEAN,
    album_id                TEXT,
    enriched_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_track_metadata_release_year ON track_metadata (release_year);
