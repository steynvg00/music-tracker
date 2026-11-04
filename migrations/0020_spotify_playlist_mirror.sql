-- 0020: spotify_playlist_mirror — local mirror of the user's Spotify playlists (v0.81, R1).
--
-- Written by scripts/sync_playlist_mirror.py (nightly, cron app token) and by the
-- Rotor hub on demand (GET /me/playlists, metadata only). Lets the hub resolve the
-- "Playing from" context, find the Daily pick playlist and rank rotation candidates
-- without paginating Spotify inside a request.
--
-- managed_kind is derived from the name suffix and only for playlists the user owns:
--   ' · Auto 🤖🔄' → auto_updating, ' · Auto 🤖📸' → auto_snapshot, ' · Custom 🎧' → custom.
-- NULL means read + play only. The mirror is informational: the hub's write guard
-- re-checks name and owner live at Spotify before every write.
--
-- Rows are never hard-deleted. A playlist that disappears from /me/playlists gets
-- removed_at (soft delete) so daily_pick_candidates and playlist_rotation_history
-- can keep their foreign keys.
--
-- Items are stored only for playlists the user owns or collaborates on: under the
-- Feb 2026 Web API rules Spotify returns items for those only.

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE TABLE spotify_playlists (
  playlist_id       text PRIMARY KEY,
  name              text NOT NULL,             -- verbatim from Spotify
  owner_id          text NOT NULL,
  owner_name        text,
  is_owned          boolean NOT NULL,
  is_collab         boolean NOT NULL DEFAULT false,
  is_public         boolean,
  managed_kind      text CHECK (managed_kind IN ('auto_updating', 'auto_snapshot', 'custom')),
  snapshot_id       text,
  track_count       int,
  image_url         text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL,      -- last time /me/playlists listed it
  removed_at        timestamptz,               -- set when it disappears from /me/playlists
  items_snapshot_id text,                      -- snapshot_id the stored items belong to (NULL = never fetched)
  items_synced_at   timestamptz,
  synced_by         text CHECK (synced_by IN ('python', 'hub')),
  CHECK (managed_kind IS NULL OR is_owned)
);

CREATE INDEX idx_spotify_playlists_live_kind ON spotify_playlists (managed_kind) WHERE removed_at IS NULL;
CREATE INDEX idx_spotify_playlists_name ON spotify_playlists (name);

CREATE TABLE spotify_playlist_items (
  playlist_id text NOT NULL REFERENCES spotify_playlists (playlist_id) ON DELETE CASCADE,
  position    int  NOT NULL,
  track_uri   text NOT NULL,                   -- spotify:track:…, spotify:episode:… or spotify:local:…
  track_name  text,                            -- verbatim from Spotify
  artist_name text,                            -- Spotify artist names joined with ', '
  duration_ms int,
  added_at    timestamptz,
  PRIMARY KEY (playlist_id, position)
);

CREATE INDEX idx_spotify_playlist_items_track ON spotify_playlist_items (track_uri);

ALTER TABLE spotify_playlists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE spotify_playlist_items ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (20, 'spotify_playlist_mirror');
