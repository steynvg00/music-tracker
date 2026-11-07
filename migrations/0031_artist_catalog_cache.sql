-- 0031: artist_catalog_cache — Rotor v0.90: storage-light cache for the Artist pages (beta).
--
-- Additive only: three new tables. Nothing existing is altered, dropped or renamed.
-- Applies after 0030 (works with or without 0025). Safe to apply before the code is deployed:
-- nothing reads these tables until the "Artist pages (beta)" flag is switched on on a device.
--
-- What is stored, and why it is this little (the database is at ~417 of 500 MB):
--   * Only artists you OPEN in Rotor (no background crawl). Rows live 7 days (TTL, refetched on the
--     next open after that) and the whole cache is capped at CATALOG_CACHE_CAP_BYTES (default 20 MB)
--     with least-recently-opened eviction (hub/src/lib/server/catalog/cache.ts).
--   * catalog_artist_cache: ONE row per artist. The discography is one compact jsonb array of arrays
--     ([id, name, date, precision, group, type, cover, total_tracks] per release; the cover URL is
--     stored without its fixed "https://i.scdn.co/image/" prefix, one size only). One row instead of
--     one row per release saves the ~24-byte tuple header + a ~40-byte index entry per release, and a
--     jsonb value above ~2 kB is compressed (TOAST) as a whole.
--   * catalog_appears_cache: for "Appears on" releases ONLY the artist's own tracks
--     ([id, name, track_number, duration_ms]), written in batches as you scroll (one row per batch of
--     albums, never rewritten). Full tracklists ("Show full album", own releases) are fetched live and
--     never stored.
--   * catalog_cache_stats: one row of counters for Data health (hit rate, evictions, 429s).
--   Compression: Postgres only compresses a row above ~2 kB (a fixed threshold; toast_tuple_target
--     can't lower it), so a large artist's releases array is compressed and an appears batch (~1.5–1.9 kB)
--     is stored as is. Measured, not assumed: see the PR.
--   bytes = pg_column_size of the artist row + its appears rows: the logical size the cap is held to.
-- Measured sizes per artist (20 / 150 / 600 releases) are in the v0.90 PR.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE catalog_artist_cache (
  artist_id   text        PRIMARY KEY,           -- Spotify artist id (22 chars)
  name        text        NOT NULL,
  image       text,                              -- one image URL (short form, see above)
  releases    jsonb       NOT NULL,              -- [[id, name, date, precision, group, type, cover, total], …]
  fetched_at  timestamptz NOT NULL,              -- TTL clock (7 days)
  accessed_at timestamptz NOT NULL,              -- LRU clock (last open)
  bytes       integer     NOT NULL DEFAULT 0     -- logical size of this artist's cache rows
);

CREATE TABLE catalog_appears_cache (
  artist_id   text        NOT NULL REFERENCES catalog_artist_cache (artist_id) ON DELETE CASCADE,
  first_album text        NOT NULL,              -- first album id of the batch: a stable, unique key
  tracks      jsonb       NOT NULL,              -- {"<album id>": [[id, name, number, duration_ms], …], …}
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (artist_id, first_album)
);

CREATE TABLE catalog_cache_stats (
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  hits         bigint      NOT NULL DEFAULT 0,   -- requests answered from the cache
  misses       bigint      NOT NULL DEFAULT 0,   -- requests that needed Spotify
  evictions    bigint      NOT NULL DEFAULT 0,   -- artists dropped to stay under the cap
  spotify_calls bigint     NOT NULL DEFAULT 0,   -- catalog requests sent to Spotify
  rate_limited bigint      NOT NULL DEFAULT 0,   -- 429 answers received
  since        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO catalog_cache_stats (id) VALUES (true);

ALTER TABLE catalog_artist_cache  ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_appears_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_cache_stats   ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (31, 'artist_catalog_cache');

COMMIT;
