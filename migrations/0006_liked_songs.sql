-- 0006: liked_songs table for Spotify saved tracks (/me/tracks)
CREATE TABLE IF NOT EXISTS liked_songs (
    track_uri    TEXT PRIMARY KEY,
    liked_at     TIMESTAMPTZ NOT NULL,
    track_name   TEXT,
    artist_name  TEXT,
    album_name   TEXT,
    synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_liked_songs_liked_at ON liked_songs (liked_at);
