-- 0023: hub_stats_rollups — Rotor R3: precomputed listening rollups + the Home stats payload (v0.83).
--
-- Additive only: three rollup tables, materialized views, one state table and three functions,
-- all in schema `hub` (created in 0022, not exposed through PostgREST, 04-architecture.md §3.5).
-- Nothing in `public` is altered or dropped.
--
-- Refresh strategy (measured on a 440k-play throwaway DB: a full refresh of everything takes
-- ~14 s, over the 5 s budget): the three per-day rollups are TABLES maintained incrementally —
-- each refresh recomputes only the local days touched by plays ingested since the last refresh
-- (high-water mark on spotify_plays.ingested_at) — and are fully rebuilt once a day so late
-- edits (backfills, deletes) are picked up. Per-track/artist rollups stay materialized views
-- refreshed CONCURRENTLY (≈ 1 s together).
--
-- Why: every heavy Streamlit stat re-scans spotify_plays (totals 1.1 s warm / 8.9 s cold,
-- streak 3.6 s, on-this-day 4.0 s; 04-architecture.md §6.4). These views are refreshed after
-- every ingest (scripts/ingest_spotify_recent.py → SELECT hub.refresh_rollups()), so Rotor's
-- Stats and Home read a few thousand pre-aggregated rows instead.
--
-- Parity with Streamlit: the views use exactly the populations Streamlit's queries use.
--   * unified_plays = spotify_plays WHERE track_uri IS NOT NULL (0004).
--   * "Unique tracks", Year in review, On this day and the rankings by artist group by the
--     artist/track TEXT, like views/stats.py does → hub.day_track keeps those texts.
--   * Artist detail counts every credited artist (track_metadata.artist_ids), like
--     views/_stats_artist_lookup.py → hub.mv_artist_stats.
--   * Local calendar days are Europe/Amsterdam everywhere.
-- Text columns are COALESCEd to '' so every key is NULL-free; the views need a unique index for
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (reads are never blocked by a refresh).

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE SCHEMA IF NOT EXISTS hub;

-- ── Per local day ────────────────────────────────────────────────────────────

-- ~3.5k rows: totals, streaks, biggest day, gaps, daily/monthly charts.
CREATE TABLE hub.daily_listening (
  d      date PRIMARY KEY,
  plays  int    NOT NULL,
  ms     bigint NOT NULL,
  tracks int    NOT NULL
);

-- Per (local day, artist text, track text): On this day, Year in review, top artist per year,
-- artist battle / rank race, discovery. ~1 row per track-day.
CREATE TABLE hub.day_track (
  d         date   NOT NULL,
  artist    text   NOT NULL,
  track     text   NOT NULL,
  plays     int    NOT NULL,
  track_uri text,
  ms        bigint NOT NULL,
  PRIMARY KEY (d, artist, track)
);
CREATE INDEX day_track_md ON hub.day_track (((extract(month FROM d) * 100 + extract(day FROM d))::int));
CREATE INDEX day_track_artist ON hub.day_track (artist);

-- Stats › Behaviour (the Streamlit "Spotify" tab): platform family, end reason, shuffle.
-- shuffle: 1 on, 0 off, -1 unknown. Platform families exactly as views/stats.py buckets them.
CREATE TABLE hub.behaviour_daily (
  d               date     NOT NULL,
  platform_family text     NOT NULL,
  reason_end      text     NOT NULL,
  shuffle         smallint NOT NULL,
  plays           int      NOT NULL,
  ms              bigint   NOT NULL,
  PRIMARY KEY (d, platform_family, reason_end, shuffle)
);

ALTER TABLE hub.daily_listening ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.day_track       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.behaviour_daily ENABLE ROW LEVEL SECURITY;

-- (Re)compute the per-day rollups for local days >= p_from (NULL = everything). One statement
-- per table, DELETE + INSERT inside the caller's transaction: readers keep seeing the old rows
-- until commit (no TRUNCATE, so nobody is ever blocked).
CREATE FUNCTION hub.rebuild_days(p_from date) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  t_from timestamptz := CASE WHEN p_from IS NULL THEN '-infinity'::timestamptz
                             ELSE (p_from::timestamp AT TIME ZONE 'Europe/Amsterdam') END;
BEGIN
  DELETE FROM hub.daily_listening WHERE p_from IS NULL OR d >= p_from;
  INSERT INTO hub.daily_listening (d, plays, ms, tracks)
  SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date, count(*), coalesce(sum(ms_played), 0), count(DISTINCT track_uri)
  FROM spotify_plays WHERE track_uri IS NOT NULL AND played_at >= t_from GROUP BY 1;

  DELETE FROM hub.day_track WHERE p_from IS NULL OR d >= p_from;
  INSERT INTO hub.day_track (d, artist, track, plays, track_uri, ms)
  SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date, coalesce(artist_name, ''), coalesce(track_name, ''),
         count(*), min(track_uri), coalesce(sum(ms_played), 0)
  FROM spotify_plays WHERE track_uri IS NOT NULL AND played_at >= t_from GROUP BY 1, 2, 3;

  DELETE FROM hub.behaviour_daily WHERE p_from IS NULL OR d >= p_from;
  INSERT INTO hub.behaviour_daily (d, platform_family, reason_end, shuffle, plays, ms)
  SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date,
         CASE
           WHEN platform LIKE '%OS X%' OR platform LIKE '%Mac OS%' OR platform LIKE '%macOS%' THEN 'Mac'
           WHEN platform LIKE '%iOS%' OR platform LIKE '%iPhone%' OR platform LIKE '%iPad%' THEN 'iOS'
           WHEN platform LIKE '%Android%' THEN 'Android'
           WHEN platform LIKE '%Windows%' THEN 'Windows'
           WHEN platform LIKE '%WebPlayer%' OR platform ILIKE '%web%' THEN 'Web'
           WHEN platform IS NULL OR platform = '' THEN 'Unknown'
           ELSE 'Other'
         END,
         coalesce(reason_end, ''),
         (CASE WHEN shuffle THEN 1 WHEN NOT shuffle THEN 0 ELSE -1 END)::smallint,
         count(*), coalesce(sum(ms_played), 0)
  FROM spotify_plays WHERE track_uri IS NOT NULL AND played_at >= t_from GROUP BY 1, 2, 3, 4;
END
$$;

SELECT hub.rebuild_days(NULL);

-- ── Per track / artist ───────────────────────────────────────────────────────

-- ~30k rows: track rankings, search, skip analysis, "your history" numbers.
CREATE MATERIALIZED VIEW hub.mv_track_stats AS
  SELECT track_uri,
         count(*)::int                                                              AS plays,
         min(played_at)                                                             AS first_played_at,
         max(played_at)                                                             AS last_played_at,
         count(*) FILTER (WHERE played_at >= now() - interval '30 days')::int        AS plays_30d,
         count(*) FILTER (WHERE played_at >= now() - interval '365 days')::int       AS plays_365d,
         count(*) FILTER (WHERE reason_end = 'fwdbtn')::int                         AS skips,
         coalesce(sum(ms_played), 0)::bigint                                        AS ms,
         coalesce(max(track_name), '')                                              AS track_name,
         coalesce(max(artist_name), '')                                             AS artist_name,
         coalesce(max(album_name), '')                                              AS album_name
  FROM spotify_plays
  WHERE track_uri IS NOT NULL
  GROUP BY 1;
CREATE UNIQUE INDEX mv_track_stats_uri ON hub.mv_track_stats (track_uri);
CREATE INDEX mv_track_stats_plays ON hub.mv_track_stats (plays DESC);

-- Every credited artist (track_metadata.artist_ids), like the Streamlit artist lookup.
CREATE MATERIALIZED VIEW hub.mv_artist_stats AS
  SELECT u.artist_id,
         max(u.artist_name)                                                         AS artist_name,
         count(*)::int                                                              AS plays,
         count(DISTINCT sp.track_uri)::int                                          AS tracks,
         min(sp.played_at)                                                          AS first_played_at,
         max(sp.played_at)                                                          AS last_played_at,
         count(*) FILTER (WHERE sp.played_at >= now() - interval '30 days')::int     AS plays_30d
  FROM spotify_plays sp
  JOIN track_metadata tm ON tm.track_uri = sp.track_uri
  CROSS JOIN LATERAL unnest(tm.artist_ids, tm.artist_names) AS u(artist_id, artist_name)
  WHERE sp.track_uri IS NOT NULL AND u.artist_id IS NOT NULL
  GROUP BY u.artist_id;
CREATE UNIQUE INDEX mv_artist_stats_id ON hub.mv_artist_stats (artist_id);
CREATE INDEX mv_artist_stats_plays ON hub.mv_artist_stats (plays DESC);

-- First local day per artist text / per (artist, track) text: discovery rate, new artists.
CREATE MATERIALIZED VIEW hub.mv_artist_first AS
  SELECT artist, min(d) AS first_d, sum(plays)::int AS plays
  FROM hub.day_track GROUP BY artist;
CREATE UNIQUE INDEX mv_artist_first_artist ON hub.mv_artist_first (artist);
CREATE INDEX mv_artist_first_d ON hub.mv_artist_first (first_d);

CREATE MATERIALIZED VIEW hub.mv_track_first AS
  SELECT artist, track, min(d) AS first_d
  FROM hub.day_track GROUP BY artist, track;
CREATE UNIQUE INDEX mv_track_first_key ON hub.mv_track_first (artist, track);
CREATE INDEX mv_track_first_d ON hub.mv_track_first (first_d);

-- ── Patterns and behaviour ───────────────────────────────────────────────────

-- 168 rows: "When you listen" heatmap. dow = EXTRACT(DOW): 0 = Sunday … 6 = Saturday.
CREATE MATERIALIZED VIEW hub.mv_hour_dow AS
  SELECT extract(dow  FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS dow,
         extract(hour FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS hour,
         count(*)::int AS plays
  FROM spotify_plays
  WHERE track_uri IS NOT NULL
  GROUP BY 1, 2;
CREATE UNIQUE INDEX mv_hour_dow_key ON hub.mv_hour_dow (dow, hour);


-- One row: the Overview totals row, same definitions as Streamlit (distinct TEXTS).
CREATE MATERIALIZED VIEW hub.mv_totals AS
  SELECT true                                                   AS id,
         (SELECT coalesce(sum(plays), 0)::bigint FROM hub.daily_listening) AS plays,
         (SELECT count(DISTINCT track)::int FROM hub.day_track)            AS unique_tracks,
         (SELECT count(DISTINCT artist)::int FROM hub.day_track)           AS unique_artists,
         (SELECT count(*)::int FROM hub.daily_listening)                   AS days,
         (SELECT min(d) FROM hub.daily_listening)                          AS first_d,
         (SELECT max(d) FROM hub.daily_listening)                          AS last_d,
         (SELECT coalesce(sum(ms), 0)::bigint FROM hub.daily_listening)    AS ms;
CREATE UNIQUE INDEX mv_totals_id ON hub.mv_totals (id);

-- ── Refresh bookkeeping ──────────────────────────────────────────────────────

CREATE TABLE hub.rollup_state (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at    timestamptz NOT NULL,
  took_ms         int NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_mark   timestamptz,                -- max(spotify_plays.ingested_at) covered by the day tables
  full_rebuilt_at timestamptz                 -- last full rebuild of the day tables
);
INSERT INTO hub.rollup_state (refreshed_at, took_ms, detail, ingested_mark, full_rebuilt_at)
SELECT now(), 0, '{"initial": true}', (SELECT max(ingested_at) FROM spotify_plays), now();
ALTER TABLE hub.rollup_state ENABLE ROW LEVEL SECURITY;

-- Refresh the rollups after an ingest. Day tables: incremental from the earliest local day of
-- any play ingested since the last mark (full rebuild when p_full, or once every 24 h). Then the
-- materialized views, CONCURRENTLY (dependency order: day_track before its children, totals
-- last). A second caller while one refresh runs returns {"skipped": true}.
CREATE FUNCTION hub.refresh_rollups(p_full boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  t0    timestamptz := clock_timestamp();
  t     timestamptz;
  v     text;
  out   jsonb := '{}'::jsonb;
  total int;
  st    hub.rollup_state;
  mark  timestamptz;
  v_from date;
  full_ boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('hub.refresh_rollups')) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;
  SELECT * INTO st FROM hub.rollup_state;
  SELECT max(ingested_at) INTO mark FROM spotify_plays;
  full_ := p_full OR st.ingested_mark IS NULL OR st.full_rebuilt_at IS NULL OR st.full_rebuilt_at < now() - interval '24 hours';

  t := clock_timestamp();
  IF full_ THEN
    PERFORM hub.rebuild_days(NULL);
    out := out || jsonb_build_object('days', 'full');
  ELSE
    SELECT min((played_at AT TIME ZONE 'Europe/Amsterdam')::date) INTO v_from
    FROM spotify_plays WHERE ingested_at > st.ingested_mark AND track_uri IS NOT NULL;
    IF v_from IS NOT NULL THEN PERFORM hub.rebuild_days(v_from); END IF;
    out := out || jsonb_build_object('days', coalesce(v_from::text, 'unchanged'));
  END IF;
  out := out || jsonb_build_object('days_ms', round(extract(epoch FROM clock_timestamp() - t) * 1000)::int);

  FOREACH v IN ARRAY ARRAY['mv_track_stats', 'mv_artist_stats', 'mv_artist_first', 'mv_track_first', 'mv_hour_dow', 'mv_totals']
  LOOP
    t := clock_timestamp();
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY hub.%I', v);
    out := out || jsonb_build_object(v, round(extract(epoch FROM clock_timestamp() - t) * 1000)::int);
  END LOOP;
  total := round(extract(epoch FROM clock_timestamp() - t0) * 1000)::int;
  UPDATE hub.rollup_state
     SET refreshed_at = now(), took_ms = total, detail = out, ingested_mark = coalesce(mark, ingested_mark),
         full_rebuilt_at = CASE WHEN full_ THEN now() ELSE full_rebuilt_at END;
  RETURN out || jsonb_build_object('total_ms', total);
END
$$;

COMMENT ON FUNCTION hub.refresh_rollups(boolean) IS
  'Refreshes the Rotor stats rollups (0023): day tables incrementally (full once a day or with p_full), MVs concurrently. Called at the end of scripts/ingest_spotify_recent.py.';

-- ── Home payload (stats part) ────────────────────────────────────────────────

-- The rollup-backed half of /api/home in one call: streaks, month tiles, On this day and
-- recent badges. The daily-pick deck and the playlist shelves stay in TypeScript (they read
-- small hub tables, not plays). Current streak = Streamlit's definition: the run of
-- consecutive listening days that ends today or yesterday.
CREATE FUNCTION hub.home_payload(p_today date) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH days AS (
    SELECT d, plays, ms, d - (row_number() OVER (ORDER BY d))::int AS grp FROM hub.daily_listening
  ),
  runs AS (
    SELECT min(d) AS start_d, max(d) AS end_d, count(*)::int AS len FROM days GROUP BY grp
  ),
  month AS (SELECT date_trunc('month', p_today)::date AS m0),
  otd AS (
    SELECT extract(year FROM dt.d)::int AS year, dt.d, dt.artist, dt.track, dt.track_uri, dt.plays,
           sum(dt.plays) OVER (PARTITION BY dt.d)::int AS day_plays,
           row_number() OVER (PARTITION BY dt.d ORDER BY dt.plays DESC, dt.artist, dt.track) AS rn
    FROM hub.day_track dt
    WHERE (extract(month FROM dt.d) * 100 + extract(day FROM dt.d))::int
          = (extract(month FROM p_today) * 100 + extract(day FROM p_today))::int
      AND dt.d < p_today
  ),
  otd_years AS (
    SELECT year,
           max(day_plays) AS plays,
           (array_agg(jsonb_build_object('track', track, 'artist', artist, 'uri', track_uri, 'plays', plays) ORDER BY rn))[1] AS top,
           (array_agg(track_uri ORDER BY rn))[1:50] AS uris
    FROM otd GROUP BY year
  ),
  badges AS (
    SELECT be.id, be.entity_type, be.entity_id, be.badge_type, be.awarded_at, be.context,
           CASE WHEN be.entity_type = 'track' THEN ts.track_name ELSE ast.artist_name END AS name,
           CASE WHEN be.entity_type = 'track' THEN ts.artist_name END AS artist
    FROM badge_events be
    LEFT JOIN hub.mv_track_stats ts ON be.entity_type = 'track' AND ts.track_uri = be.entity_id
    LEFT JOIN hub.mv_artist_stats ast ON be.entity_type = 'artist' AND ast.artist_id = be.entity_id
    ORDER BY be.awarded_at DESC, be.id DESC
    LIMIT 8
  )
  SELECT jsonb_build_object(
    'today', p_today,
    'refreshedAt', (SELECT refreshed_at FROM hub.rollup_state),
    'streak', jsonb_build_object(
      'current', coalesce((SELECT len FROM runs WHERE end_d >= p_today - 1 ORDER BY end_d DESC LIMIT 1), 0),
      'longest', coalesce((SELECT max(len) FROM runs), 0),
      'listenedToday', EXISTS (SELECT 1 FROM hub.daily_listening WHERE d = p_today)
    ),
    'month', jsonb_build_object(
      'plays', (SELECT coalesce(sum(plays), 0)::int FROM hub.daily_listening, month WHERE d >= m0 AND d <= p_today),
      'hours', (SELECT round(coalesce(sum(ms), 0) / 3600000.0, 1) FROM hub.daily_listening, month WHERE d >= m0 AND d <= p_today),
      'newArtists', (SELECT count(*)::int FROM hub.mv_artist_first, month WHERE first_d >= m0 AND first_d <= p_today AND artist <> '')
    ),
    'onThisDay', coalesce((SELECT jsonb_agg(jsonb_build_object('year', year, 'plays', plays, 'top', top, 'uris', to_jsonb(uris)) ORDER BY year DESC) FROM otd_years), '[]'::jsonb),
    'recentBadges', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'entityType', entity_type, 'entityId', entity_id, 'badgeType', badge_type, 'awardedAt', awarded_at,
        'context', coalesce(context, '{}'::jsonb), 'name', name, 'artist', artist) ORDER BY awarded_at DESC, id DESC) FROM badges), '[]'::jsonb)
  )
$$;

COMMENT ON FUNCTION hub.home_payload(date) IS
  'Rotor Home stats (0023): streaks, month tiles, On this day, recent badges. Reads only hub rollups + badge_events.';

-- Belt and braces: schema hub is not exposed through PostgREST, but if Supabase's API roles
-- exist, make sure they can't reach it anyway.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA hub FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA hub FROM anon';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hub FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA hub FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA hub FROM authenticated';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hub FROM authenticated';
  END IF;
END
$$;

INSERT INTO migrations_applied (number, name) VALUES (23, 'hub_stats_rollups');
