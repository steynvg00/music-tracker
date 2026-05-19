-- 0001_initial.sql
-- Initial schema for music-tracker
-- Tables: artists, albums, tracks, scrobbles
-- Run manually in the Supabase SQL Editor.

CREATE TABLE artists (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  mbid TEXT UNIQUE,
  spotify_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_artists_name_lower ON artists (lower(name));

CREATE TABLE albums (
  id BIGSERIAL PRIMARY KEY,
  artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mbid TEXT UNIQUE,
  spotify_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artist_id, lower(title))
);

CREATE TABLE tracks (
  id BIGSERIAL PRIMARY KEY,
  artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  album_id BIGINT REFERENCES albums(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  mbid TEXT UNIQUE,
  spotify_id TEXT UNIQUE,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tracks_artist_title_lower ON tracks (artist_id, lower(title));

CREATE TABLE scrobbles (
  id BIGSERIAL PRIMARY KEY,
  track_id BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('lastfm', 'spotify_extended')),
  ms_played INTEGER,
  reason_start TEXT,
  reason_end TEXT,
  shuffle BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, played_at, track_id)
);
CREATE INDEX idx_scrobbles_played_at ON scrobbles (played_at);
CREATE INDEX idx_scrobbles_track_id ON scrobbles (track_id);

CREATE TABLE migrations_applied (
  number INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO migrations_applied (number, name) VALUES (1, 'initial');
