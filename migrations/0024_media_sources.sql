-- 0024: media_sources — Rotor R4: YouTube + SoundCloud collections ("Elsewhere") (v0.84).
--
-- Additive only: three new tables. Nothing existing is altered or dropped.
--
-- Elsewhere is a separate space (03-ux-ia.md §3, Spotify policy III.5 / design guideline "never
-- seated next to content from similar services"): these tables are never joined into any Spotify
-- list, shelf, queue or stat. Spotify playlists stay in spotify_playlists.
--
-- media_items: one YouTube video or SoundCloud track/set. `embeddable` = YouTube
-- status.embeddable at import (false → skipped with a notice); `is_preview_only` = SoundCloud
-- Go+ 30-second preview (detected by the widget, then skipped). `last_checked_at` drives the
-- YouTube API Services III.E.4 rule: stored API data is refreshed (or deleted) within 30 days
-- (scripts/refresh_collections.py, daily hub-jobs run).
--
-- collections: an imported YouTube playlist or SoundCloud set (or a single pasted track).
-- collection_items: their order.
--
-- RLS on, no policies, on every new table (deny-all for PostgREST/anon).

SET statement_timeout = 0;
SET lock_timeout = '15s';

CREATE TABLE media_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL CHECK (source IN ('youtube', 'soundcloud')),
  source_id       text NOT NULL,                 -- YouTube video id / SoundCloud permalink URL
  title           text NOT NULL,                 -- verbatim from the source
  artist_display  text,                          -- channel / uploader
  duration_ms     int,
  artwork_url     text,
  embeddable      boolean,                       -- YouTube status.embeddable; NULL = unknown
  is_preview_only boolean NOT NULL DEFAULT false,-- SoundCloud Go+ preview (30 s)
  unavailable     boolean NOT NULL DEFAULT false,-- removed / private at the last check
  last_checked_at timestamptz NOT NULL,
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, source_id)
);
CREATE INDEX idx_media_items_checked ON media_items (source, last_checked_at);

CREATE TABLE collections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source               text NOT NULL CHECK (source IN ('youtube', 'soundcloud')),
  source_collection_id text NOT NULL,            -- YouTube playlist id / SoundCloud set or track URL
  kind                 text NOT NULL CHECK (kind IN ('playlist', 'set', 'likes_set', 'manual')),
  title                text NOT NULL,
  owner_display        text,
  url                  text NOT NULL,            -- canonical URL the user pasted (normalised)
  artwork_url          text,
  item_count           int NOT NULL DEFAULT 0,
  embed_html           text,                     -- SoundCloud oEmbed html (widget iframe), as returned
  imported_at          timestamptz NOT NULL DEFAULT now(),
  last_synced_at       timestamptz NOT NULL DEFAULT now(),
  last_import_units    int,                      -- YouTube Data API quota units the last import/sync used
  UNIQUE (source, source_collection_id)
);

CREATE TABLE collection_items (
  collection_id uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  position      int  NOT NULL,
  media_item_id uuid NOT NULL REFERENCES media_items (id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, position)
);
CREATE INDEX idx_collection_items_media ON collection_items (media_item_id);

ALTER TABLE media_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_items ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (24, 'media_sources');
