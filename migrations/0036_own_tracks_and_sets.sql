-- 0036: own_tracks_and_sets — Rotor v0.94: own tracks (unreleased songs / IDs), DJ & live sets,
-- uploads in object storage, Rotor-only lists and Rotor plays of own tracks.
--
-- Additive, METADATA ONLY. Audio and cover files never enter the database: they live in object storage
-- (a private Supabase Storage bucket by default, any S3-compatible backend via env vars; see
-- hub/src/lib/server/storage/). This migration only stores object keys, sizes and upload state.
-- Applies after 0035; independent of 0025 (R5) and 0033 (scrobbles drop).
--
-- New tables (RLS on, no policies: deny-all for PostgREST/anon, like every Rotor table):
--   media_objects       one uploaded file: object key (backend-independent, so switching storage is a
--                       config change + scripts/migrate_media_storage.py), type, size, upload state, the
--                       multipart upload id and the parts the browser reported done (resume).
--   rotor_artists       an artist that is not (yet) in your Spotify history, created explicitly.
--   own_tracks          an own track: title, version, status, duration, label, dates, where you heard it,
--                       notes, cover, sources (YouTube / SoundCloud / uploaded file: at least one).
--   own_track_artists   its credits: primary / featuring / remixer / producer, each linked to an artist
--                       from your data (Spotify artist id) or a rotor_artists row; never free text.
--   dj_sets             a DJ / live set: title, event, date, duration, cover, ONE source.
--   dj_set_artists      its DJs / artists (linked like above).
--   dj_set_tracks       its optional tracklist: start time + a catalog track, an own track or "ID".
--   own_plays           a play of an own track in Rotor's own player. source = 'rotor' ONLY: never mixed
--                       into spotify_plays or any Spotify rollup.
--   rotor_lists         Rotor-only lists of own tracks (never a Spotify playlist).
--   rotor_list_items    their order.
--
-- One widening (like 0027's): library_items.item_key (0034) also accepts rotor:own:<uuid>,
-- rotor:list:<uuid> and rotor:set:<uuid>, so own tracks, lists and sets can be pinned and foldered.
--
-- Placeholders ("unknown", "?", "ID - ID", "tba", …) are refused by rotor_is_placeholder() in CHECKs,
-- on top of the hub's client + server validation.
--
-- Size: empty tables + indexes ≈ 200 kB. Per row: own track ~0.3–0.6 kB (+ ~0.1 kB per credit),
-- set ~0.3 kB, tracklist entry ~0.1 kB, play ~60 B, media object ~0.2 kB. 1,000 own tracks with
-- 20 sets of 30 entries and 10,000 plays ≈ 2 MB. Measured on the E2E database in the v0.94 PR.

BEGIN;

SET LOCAL lock_timeout = '15s';

-- "unknown", "?", "n/a", "tba", "untitled", "ID - ID", "-", … (case/space-insensitive).
CREATE FUNCTION rotor_is_placeholder(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT v IS NULL
      OR btrim(v) = ''
      OR lower(regexp_replace(btrim(v), '\s+', ' ', 'g')) IN (
           'unknown', 'unknown artist', 'unknown title', 'unknown track', '?', '??', '???', '-', '--', '—',
           'n/a', 'na', 'none', 'null', 'tba', 'tbc', 'tbd', 'untitled', 'no title', 'id', 'id - id', 'id-id',
           'id – id', 'id — id', 'unreleased', 'xxx', '...', '…')
      OR btrim(v) ~ '^[?.\-–—_*\s]+$'
$$;

CREATE TABLE media_objects (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key    text        NOT NULL UNIQUE CHECK (object_key ~ '^(tracks|sets|covers)/[0-9a-f-]{36}\.[a-z0-9]{2,5}$'),
  purpose       text        NOT NULL CHECK (purpose IN ('track', 'set', 'cover')),
  content_type  text        NOT NULL,
  size_bytes    bigint      NOT NULL CHECK (size_bytes > 0),
  original_name text,
  status        text        NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'deleting', 'failed')),
  upload_id     text,                                   -- S3 multipart UploadId; NULL = one signed PUT
  part_size     integer     CHECK (part_size IS NULL OR part_size >= 5242880),
  parts         jsonb       NOT NULL DEFAULT '[]'::jsonb, -- [{"n": 1, "etag": "\"…\""}]: parts the browser finished
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CHECK (status <> 'ready' OR completed_at IS NOT NULL)
);
CREATE INDEX media_objects_status ON media_objects (status, created_at);

CREATE TABLE rotor_artists (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200 AND NOT rotor_is_placeholder(name)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rotor_artists_name ON rotor_artists (lower(btrim(name)));

CREATE TABLE dj_sets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND NOT rotor_is_placeholder(title)),
  event           text        CHECK (event IS NULL OR char_length(event) <= 200),
  performed_on    date,
  duration_ms     integer     NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 86400000),
  cover_url       text        CHECK (cover_url IS NULL OR cover_url ~ '^https://'),
  cover_object_id uuid        REFERENCES media_objects (id) ON DELETE SET NULL,
  source          text        NOT NULL CHECK (source IN ('youtube', 'soundcloud', 'upload')),
  youtube_id      text        CHECK (youtube_id IS NULL OR youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  soundcloud_url  text        CHECK (soundcloud_url IS NULL OR soundcloud_url ~ '^https://soundcloud\.com/'),
  audio_object_id uuid        REFERENCES media_objects (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source = 'youtube'    AND youtube_id IS NOT NULL     AND soundcloud_url IS NULL AND audio_object_id IS NULL) OR
    (source = 'soundcloud' AND soundcloud_url IS NOT NULL AND youtube_id IS NULL     AND audio_object_id IS NULL) OR
    (source = 'upload'     AND audio_object_id IS NOT NULL AND youtube_id IS NULL    AND soundcloud_url IS NULL)
  )
);

CREATE TABLE own_tracks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND NOT rotor_is_placeholder(title)),
  version         text        CHECK (version IS NULL OR (char_length(btrim(version)) BETWEEN 1 AND 100 AND NOT rotor_is_placeholder(version))),
  status          text        NOT NULL CHECK (status IN ('unreleased', 'id', 'released_elsewhere')),
  duration_ms     integer     NOT NULL CHECK (duration_ms >= 1000 AND duration_ms <= 7200000),
  label           text        CHECK (label IS NULL OR (char_length(btrim(label)) BETWEEN 1 AND 200 AND NOT rotor_is_placeholder(label))),
  date_kind       text        CHECK (date_kind IN ('release', 'first_heard')),
  date_value      date,
  heard_set_id    uuid        REFERENCES dj_sets (id) ON DELETE SET NULL,
  heard_at_ms     integer     CHECK (heard_at_ms IS NULL OR heard_at_ms >= 0),
  heard_note      text        CHECK (heard_note IS NULL OR char_length(heard_note) <= 300),
  notes           text        CHECK (notes IS NULL OR char_length(notes) <= 4000),
  cover_url       text        CHECK (cover_url IS NULL OR cover_url ~ '^https://'),
  cover_object_id uuid        REFERENCES media_objects (id) ON DELETE SET NULL,
  youtube_id      text        CHECK (youtube_id IS NULL OR youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  soundcloud_url  text        CHECK (soundcloud_url IS NULL OR soundcloud_url ~ '^https://soundcloud\.com/'),
  -- RESTRICT: a file that is a track's only source can't disappear underneath it (the hub's guarded delete
  -- refuses with "add another source first, or delete the track").
  audio_object_id uuid        REFERENCES media_objects (id) ON DELETE RESTRICT,
  dupe_key        text        NOT NULL,                 -- normalised "artists|title|version" (duplicate check)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (youtube_id IS NOT NULL OR soundcloud_url IS NOT NULL OR audio_object_id IS NOT NULL),
  CHECK ((date_kind IS NULL) = (date_value IS NULL))
);
CREATE INDEX own_tracks_dupe ON own_tracks (dupe_key);
CREATE INDEX own_tracks_heard_set ON own_tracks (heard_set_id) WHERE heard_set_id IS NOT NULL;

-- Credits of own tracks and sets: always linked to an artist (yours from Spotify, or a Rotor artist).
CREATE TABLE own_track_artists (
  own_track_id      uuid     NOT NULL REFERENCES own_tracks (id) ON DELETE CASCADE,
  role              text     NOT NULL CHECK (role IN ('primary', 'featuring', 'remixer', 'producer')),
  position          smallint NOT NULL CHECK (position >= 0),
  spotify_artist_id text     CHECK (spotify_artist_id IS NULL OR spotify_artist_id ~ '^[A-Za-z0-9]{22}$'),
  rotor_artist_id   uuid     REFERENCES rotor_artists (id) ON DELETE RESTRICT,
  name              text     NOT NULL CHECK (NOT rotor_is_placeholder(name)),  -- display name at link time
  PRIMARY KEY (own_track_id, role, position),
  CHECK ((spotify_artist_id IS NULL) <> (rotor_artist_id IS NULL))
);
CREATE INDEX own_track_artists_spotify ON own_track_artists (spotify_artist_id) WHERE spotify_artist_id IS NOT NULL;
CREATE INDEX own_track_artists_rotor ON own_track_artists (rotor_artist_id) WHERE rotor_artist_id IS NOT NULL;

CREATE TABLE dj_set_artists (
  set_id            uuid     NOT NULL REFERENCES dj_sets (id) ON DELETE CASCADE,
  position          smallint NOT NULL CHECK (position >= 0),
  spotify_artist_id text     CHECK (spotify_artist_id IS NULL OR spotify_artist_id ~ '^[A-Za-z0-9]{22}$'),
  rotor_artist_id   uuid     REFERENCES rotor_artists (id) ON DELETE RESTRICT,
  name              text     NOT NULL CHECK (NOT rotor_is_placeholder(name)),
  PRIMARY KEY (set_id, position),
  CHECK ((spotify_artist_id IS NULL) <> (rotor_artist_id IS NULL))
);
CREATE INDEX dj_set_artists_spotify ON dj_set_artists (spotify_artist_id) WHERE spotify_artist_id IS NOT NULL;
CREATE INDEX dj_set_artists_rotor ON dj_set_artists (rotor_artist_id) WHERE rotor_artist_id IS NOT NULL;

-- Tracklist: "ID" entries are free text, clearly marked; own-track links are RESTRICT (deleting an own track
-- turns its entries into "ID" entries first, keeping the text).
CREATE TABLE dj_set_tracks (
  set_id         uuid     NOT NULL REFERENCES dj_sets (id) ON DELETE CASCADE,
  position       smallint NOT NULL CHECK (position >= 0),
  start_ms       integer  CHECK (start_ms IS NULL OR start_ms >= 0),
  kind           text     NOT NULL CHECK (kind IN ('catalog', 'own', 'id')),
  track_uri      text     CHECK (track_uri IS NULL OR track_uri ~ '^spotify:track:[A-Za-z0-9]{22}$'),
  own_track_id   uuid     REFERENCES own_tracks (id) ON DELETE RESTRICT,
  display_artist text     CHECK (display_artist IS NULL OR char_length(display_artist) <= 300),
  display_title  text     NOT NULL CHECK (char_length(display_title) BETWEEN 1 AND 300),
  PRIMARY KEY (set_id, position),
  CHECK (
    (kind = 'catalog' AND track_uri IS NOT NULL AND own_track_id IS NULL) OR
    (kind = 'own'     AND own_track_id IS NOT NULL AND track_uri IS NULL) OR
    (kind = 'id'      AND track_uri IS NULL AND own_track_id IS NULL)
  )
);
CREATE INDEX dj_set_tracks_own ON dj_set_tracks (own_track_id) WHERE own_track_id IS NOT NULL;

-- Plays in Rotor's own player. Never spotify_plays, never in the Spotify rollups.
CREATE TABLE own_plays (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  own_track_id uuid        NOT NULL REFERENCES own_tracks (id) ON DELETE CASCADE,
  played_at    timestamptz NOT NULL DEFAULT now(),
  ms_played    integer     NOT NULL CHECK (ms_played >= 0),
  source       text        NOT NULL DEFAULT 'rotor' CHECK (source = 'rotor')
);
CREATE INDEX own_plays_track ON own_plays (own_track_id, played_at);

CREATE TABLE rotor_lists (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100 AND NOT rotor_is_placeholder(name)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rotor_list_items (
  list_id      uuid     NOT NULL REFERENCES rotor_lists (id) ON DELETE CASCADE,
  position     integer  NOT NULL CHECK (position >= 0),
  own_track_id uuid     NOT NULL REFERENCES own_tracks (id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, position),
  UNIQUE (list_id, own_track_id)
);
CREATE INDEX rotor_list_items_track ON rotor_list_items (own_track_id);

-- 0034 widening: own tracks, Rotor lists and sets can be pinned and put in folders.
ALTER TABLE library_items DROP CONSTRAINT library_items_item_key_check;
ALTER TABLE library_items ADD CONSTRAINT library_items_item_key_check CHECK (
  item_key ~ '^(spotify:playlist:[A-Za-z0-9]{22}|rotor:liked|rotor:collection:[0-9a-f-]{36}|rotor:(own|list|set):[0-9a-f-]{36})$'
);

ALTER TABLE media_objects     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotor_artists     ENABLE ROW LEVEL SECURITY;
ALTER TABLE dj_sets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE own_tracks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE own_track_artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE dj_set_artists    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dj_set_tracks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE own_plays         ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotor_lists       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotor_list_items  ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (36, 'own_tracks_and_sets');

COMMIT;
