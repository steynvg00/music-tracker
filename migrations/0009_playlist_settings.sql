CREATE TABLE IF NOT EXISTS playlist_settings (
    playlist_id     VARCHAR(50)  PRIMARY KEY,
    playlist_name   VARCHAR(200),
    order_pref      VARCHAR(30)  NOT NULL DEFAULT 'default',
    force_refresh_requested_at TIMESTAMPTZ,
    force_refresh_completed_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playlist_settings_force_refresh
    ON playlist_settings (force_refresh_requested_at)
    WHERE force_refresh_requested_at IS NOT NULL;
