-- 0008: custom_playlists table for tracking user-created temporary playlists
CREATE TABLE IF NOT EXISTS custom_playlists (
    playlist_id   TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,         -- NULL = permanent, otherwise sweep deletes when expires_at < NOW()
    track_count   INTEGER NOT NULL DEFAULT 0,
    filters_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_custom_playlists_expires_at ON custom_playlists (expires_at)
    WHERE expires_at IS NOT NULL;
