-- 0022: hub_jobs_and_push — Rotor R2: job queue, Web Push, custom-playlist filters,
-- playlist rules catalog, and the shared custom-playlist preview function (v0.82).
--
-- Additive only: new tables, new nullable/defaulted columns, a new schema `hub` with one
-- function. Nothing existing is altered in a breaking way or dropped.
--
-- hub_jobs: work the hub requests from Python. The hub inserts a row and dispatches
-- .github/workflows/hub-jobs.yml with the row id; scripts/run_hub_job.py claims it
-- (queued → running, atomically), runs it and writes done/failed + result. A partial
-- unique index on dedupe_key makes "Shuffle the deck" / "Refresh now" idempotent while
-- a job is still active.
--
-- push_subscriptions: Web Push endpoints of the owner's devices (sent by Python,
-- lib/web_push.py). push_log de-duplicates one-off notifications (token expiry).
--
-- custom_playlists gets filters_json + excluded_uris so a custom playlist can be edited
-- with its original filters (03-ux-ia.md flow d).
--
-- playlist_rule_categories + spotify_playlists.rule_category: the 16 rule categories of
-- lib/playlists.py, exported by lib/rules_catalog.py, so the hub can show the Rules view
-- and "About this playlist" without running Python.
--
-- hub.custom_playlist_preview(filters jsonb): the SQL of
-- lib/temporary_playlists.query_temp_playlist_tracks as one function, called by both
-- Streamlit (Python) and Rotor (TypeScript) so their previews can't drift. Schema `hub`
-- is not in PostgREST's exposed schemas (04-architecture.md §3.5).
--
-- RLS on, no policies, on every new table (deny-all for PostgREST/anon).

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

-- ── Jobs ─────────────────────────────────────────────────────────────────────

CREATE TABLE hub_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('reseed_daily_pick', 'refresh_managed', 'push_test')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text,                           -- e.g. 'reseed:2026-11-05', 'refresh:<playlist_id>'
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts     smallint NOT NULL DEFAULT 0,    -- incremented by every claim
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb,
  error        text,
  run_url      text                            -- GitHub Actions run that executed it
);

CREATE UNIQUE INDEX idx_hub_jobs_active_dedupe
  ON hub_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX idx_hub_jobs_requested ON hub_jobs (requested_at DESC);

-- ── Web Push ─────────────────────────────────────────────────────────────────

CREATE TABLE push_subscriptions (
  endpoint        text PRIMARY KEY,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  device_label    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failures        int NOT NULL DEFAULT 0
);

CREATE TABLE push_log (
  dedupe_key text PRIMARY KEY,                 -- e.g. 'token:hub:2027-05-04:14'
  kind       text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  delivered  int NOT NULL DEFAULT 0
);

-- ── Custom playlists: editable filters ───────────────────────────────────────

ALTER TABLE custom_playlists
  ADD COLUMN filters_json  jsonb,
  ADD COLUMN excluded_uris text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN custom_playlists.filters_json IS
  'Filters as passed to hub.custom_playlist_preview(); NULL for playlists created before v0.82.';

-- ── Rules catalog ────────────────────────────────────────────────────────────

CREATE TABLE playlist_rule_categories (
  key              text PRIMARY KEY,           -- CAT_* in lib/playlists.py, or 'uncategorised'
  position         int  NOT NULL,
  name             text NOT NULL,
  kind             text NOT NULL,              -- 'updating' | 'snapshot'
  playlist_count   int  NOT NULL,
  name_form        text NOT NULL,
  rule_nl          text NOT NULL,
  schedule_kind    text NOT NULL,              -- 'refresh' | 'next_creation' | 'none'
  schedule_nl      text NOT NULL,
  next_creation_nl text NOT NULL,
  cron             text NOT NULL,
  cron_job         text NOT NULL,
  cron_script      text NOT NULL,
  member_variation text NOT NULL,
  variants         jsonb NOT NULL DEFAULT '[]'::jsonb,
  example_names    text[] NOT NULL DEFAULT '{}',
  notes            text NOT NULL,
  query_sources    jsonb NOT NULL DEFAULT '[]'::jsonb,
  exported_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE spotify_playlists ADD COLUMN rule_category text;
CREATE INDEX idx_spotify_playlists_rule_category ON spotify_playlists (rule_category) WHERE rule_category IS NOT NULL;

-- ── Shared custom-playlist preview ───────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS hub;

-- filters: { artists: text[], release_year_min, release_year_max, discovery_year_min,
--            discovery_year_max, min_plays, max_tracks (default 100, cap 10000),
--            liked_only (bool), sort_order }
-- Same semantics as the Python it replaces: artist = ILIKE '%name%' OR-ed, min_plays in
-- HAVING, release/discovery years AND-ed, liked_only = inner join on liked_songs.
CREATE FUNCTION hub.custom_playlist_preview(filters jsonb)
RETURNS TABLE (
  track_uri       text,
  track_name      text,
  artist_name     text,
  album_name      text,
  plays           bigint,
  first_played_at timestamptz,
  release_year    int,
  release_date    text
)
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  WITH f AS (
    SELECT
      CASE WHEN jsonb_typeof(filters->'artists') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(filters->'artists')) END AS artists,
      (filters->>'release_year_min')::int   AS release_year_min,
      (filters->>'release_year_max')::int   AS release_year_max,
      (filters->>'discovery_year_min')::int AS discovery_year_min,
      (filters->>'discovery_year_max')::int AS discovery_year_max,
      (filters->>'min_plays')::int          AS min_plays,
      LEAST(COALESCE((filters->>'max_tracks')::int, 100), 10000) AS max_tracks,
      COALESCE((filters->>'liked_only')::boolean, false) AS liked_only,
      CASE WHEN filters->>'sort_order' IN ('random', 'plays_desc', 'plays_asc', 'first_play_asc',
                                           'first_play_desc', 'release_asc', 'release_desc')
           THEN filters->>'sort_order' ELSE 'plays_desc' END AS sort_order
  ),
  per_track AS (
    SELECT
      sp.track_uri,
      MAX(sp.track_name)  AS track_name,
      MAX(sp.artist_name) AS artist_name,
      MAX(sp.album_name)  AS album_name,
      COUNT(*)            AS plays,
      MIN(sp.played_at)   AS first_played_at
    FROM spotify_plays sp, f
    WHERE sp.track_uri IS NOT NULL
      AND (f.artists IS NULL OR cardinality(f.artists) = 0
           OR EXISTS (SELECT 1 FROM unnest(f.artists) a WHERE sp.artist_name ILIKE '%' || a || '%'))
    GROUP BY sp.track_uri, f.min_plays
    HAVING f.min_plays IS NULL OR COUNT(*) >= f.min_plays
  )
  SELECT pt.track_uri, pt.track_name, pt.artist_name, pt.album_name, pt.plays, pt.first_played_at,
         tm.release_year, tm.release_date
  FROM per_track pt
  CROSS JOIN f
  LEFT JOIN track_metadata tm ON tm.track_uri = pt.track_uri
  WHERE (NOT f.liked_only OR EXISTS (SELECT 1 FROM liked_songs ls WHERE ls.track_uri = pt.track_uri))
    AND (f.release_year_min IS NULL OR tm.release_year >= f.release_year_min)
    AND (f.release_year_max IS NULL OR tm.release_year <= f.release_year_max)
    AND (f.discovery_year_min IS NULL
         OR EXTRACT(YEAR FROM pt.first_played_at AT TIME ZONE 'Europe/Amsterdam')::int >= f.discovery_year_min)
    AND (f.discovery_year_max IS NULL
         OR EXTRACT(YEAR FROM pt.first_played_at AT TIME ZONE 'Europe/Amsterdam')::int <= f.discovery_year_max)
  ORDER BY
    CASE WHEN f.sort_order = 'random' THEN random() END,
    CASE WHEN f.sort_order = 'plays_desc' THEN pt.plays END DESC,
    CASE WHEN f.sort_order = 'plays_asc' THEN pt.plays END ASC,
    CASE WHEN f.sort_order IN ('plays_desc', 'plays_asc') THEN pt.first_played_at END ASC,
    CASE WHEN f.sort_order = 'first_play_asc' THEN pt.first_played_at END ASC,
    CASE WHEN f.sort_order = 'first_play_desc' THEN pt.first_played_at END DESC,
    CASE WHEN f.sort_order = 'release_asc' THEN tm.release_date END ASC NULLS LAST,
    CASE WHEN f.sort_order = 'release_desc' THEN tm.release_date END DESC NULLS LAST,
    CASE WHEN f.sort_order IN ('release_asc', 'release_desc') THEN pt.plays END DESC
  LIMIT (SELECT max_tracks FROM f)
$$;

COMMENT ON FUNCTION hub.custom_playlist_preview(jsonb) IS
  'Custom-playlist selection shared by Streamlit (lib/temporary_playlists.py) and Rotor (hub/src/lib/server/custom.ts).';

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE hub_jobs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_log                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlist_rule_categories ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (22, 'hub_jobs_and_push');
