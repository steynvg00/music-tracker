-- 0002_track_spotify_searched.sql
-- Adds spotify_searched flag to tracks so the Spotify-lookup job
-- skips tracks that have already been searched without a match.

ALTER TABLE tracks ADD COLUMN spotify_searched BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_tracks_unsearched ON tracks (id) WHERE NOT spotify_searched;

INSERT INTO migrations_applied (number, name) VALUES (2, 'track_spotify_searched');
