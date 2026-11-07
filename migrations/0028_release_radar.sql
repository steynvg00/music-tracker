-- 0028: release_radar — Rotor R7: upcoming and new releases from the artists you listen to (v0.87).
--
-- Additive only: six new tables. Nothing existing is altered, dropped or renamed; no new hub job
-- kind (the radar runs as a step of the existing daily hub-jobs.yml run), so hub_jobs.kind is
-- untouched. Requires nothing beyond 0001–0014 (spotify_plays, track_metadata, liked_songs); the
-- hub screens also read 0023's rollups. Applies after 0027.
--
--   radar_releases          one row per release, merged across sources (lib/release_radar/store.py)
--   radar_release_sources   what each source said about it (artist/title/label/date/url as given)
--   radar_sources           per-source health: last run/success, error, failure streak, alert sent
--   radar_followed_artists  "Follow in Rotor" (adds an artist to the radar; never a Spotify follow)
--   radar_mb_artists        cache: Spotify artist → MusicBrainz artist (or "no match", rechecked)
--   radar_runs              one row per daily run (summary, for Data health / debugging)

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE radar_releases (
  id               bigserial   PRIMARY KEY,
  artist_key       text        NOT NULL,           -- normalised artist (match.norm_artist)
  artist_name      text        NOT NULL,           -- as the first source wrote it
  artist_id        text,                           -- Spotify artist id when known
  title            text        NOT NULL,
  title_key        text        NOT NULL,           -- normalised title (match.norm_title)
  release_date     date,
  date_precision   text        CHECK (date_precision IN ('day', 'month', 'year')),
  release_type     text,
  label            text,
  spotify_album_id text,
  spotify_url      text,
  track_uris       text[]      NOT NULL DEFAULT '{}',   -- Spotify releases of the last 14 days
  in_library       boolean     NOT NULL DEFAULT false,  -- a track of it played or liked
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_releases_key ON radar_releases (artist_key, title_key);
CREATE INDEX radar_releases_date ON radar_releases (release_date);
CREATE UNIQUE INDEX radar_releases_spotify_album ON radar_releases (spotify_album_id) WHERE spotify_album_id IS NOT NULL;

CREATE TABLE radar_release_sources (
  source       text        NOT NULL CHECK (source IN ('spotify', 'musicbrainz', 'scantraxx')),
  external_id  text        NOT NULL,
  release_id   bigint      NOT NULL REFERENCES radar_releases (id) ON DELETE CASCADE,
  artist       text        NOT NULL,
  title        text        NOT NULL,
  label        text,
  release_date date,
  url          text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
CREATE INDEX radar_release_sources_release ON radar_release_sources (release_id);

CREATE TABLE radar_sources (
  source               text        PRIMARY KEY CHECK (source IN ('spotify', 'musicbrainz', 'scantraxx')),
  enabled              boolean     NOT NULL DEFAULT true,
  disabled_reason      text,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_failures int         NOT NULL DEFAULT 0,
  failing_since        date,                      -- first failed day of the current streak
  failure_notified_at  timestamptz,               -- the one push for this streak was sent
  last_items           int,
  detail               jsonb       NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO radar_sources (source) VALUES ('spotify'), ('musicbrainz'), ('scantraxx');

CREATE TABLE radar_followed_artists (
  artist_id   text        PRIMARY KEY CHECK (artist_id ~ '^[A-Za-z0-9]{22}$'),
  name        text        NOT NULL,
  followed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radar_mb_artists (
  artist_ref text        PRIMARY KEY,             -- Spotify artist id, or 'name:<normalised name>'
  name       text        NOT NULL,
  mbid       text,                                -- NULL = no unambiguous match (rechecked after 30 days)
  mb_name    text,
  matched_by text        CHECK (matched_by IN ('spotify_url', 'name')),
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radar_runs (
  id       bigserial   PRIMARY KEY,
  ran_at   timestamptz NOT NULL DEFAULT now(),
  took_ms  int         NOT NULL,
  artists  int         NOT NULL,
  summary  jsonb       NOT NULL
);

ALTER TABLE radar_releases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_release_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_sources          ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_followed_artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_mb_artists       ENABLE ROW LEVEL SECURITY;
ALTER TABLE radar_runs             ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (28, 'release_radar');

COMMIT;
