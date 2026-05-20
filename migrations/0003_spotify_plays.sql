CREATE TABLE IF NOT EXISTS spotify_plays (
    id BIGSERIAL PRIMARY KEY,
    played_at TIMESTAMPTZ NOT NULL,
    ms_played INTEGER NOT NULL,
    platform TEXT,
    country TEXT,
    track_uri TEXT,
    track_name TEXT,
    artist_name TEXT,
    album_name TEXT,
    episode_uri TEXT,
    episode_name TEXT,
    show_name TEXT,
    audiobook_uri TEXT,
    audiobook_title TEXT,
    audiobook_chapter_uri TEXT,
    audiobook_chapter_title TEXT,
    reason_start TEXT,
    reason_end TEXT,
    shuffle BOOLEAN,
    skipped BOOLEAN,
    offline BOOLEAN,
    offline_timestamp BIGINT,
    incognito_mode BOOLEAN,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: a single (played_at, track_uri OR episode_uri OR audiobook_chapter_uri) should not duplicate.
-- Use a partial unique index per content type since each row has only one of the three URIs.
CREATE UNIQUE INDEX IF NOT EXISTS spotify_plays_track_unique
    ON spotify_plays (played_at, track_uri)
    WHERE track_uri IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS spotify_plays_episode_unique
    ON spotify_plays (played_at, episode_uri)
    WHERE episode_uri IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS spotify_plays_audiobook_unique
    ON spotify_plays (played_at, audiobook_chapter_uri)
    WHERE audiobook_chapter_uri IS NOT NULL;

-- Query indexes
CREATE INDEX IF NOT EXISTS spotify_plays_played_at_idx ON spotify_plays (played_at);
CREATE INDEX IF NOT EXISTS spotify_plays_artist_name_idx ON spotify_plays (artist_name);
CREATE INDEX IF NOT EXISTS spotify_plays_track_uri_idx ON spotify_plays (track_uri);
