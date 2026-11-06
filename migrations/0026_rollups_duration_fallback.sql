-- 0026: rollups_duration_fallback — Rotor R3 fix: listening time for API-ingested plays (v0.83).
--
-- Bug: spotify_plays.ms_played is NULL for every play from the recently-played API (since 0005:
-- the API does not report it). 0023 summed ms_played as-is, so every hours/ms rollup counted those
-- plays as 0 ms. Since all recent plays come from the API, Home said "0 h this month".
--
-- Fix: a play's listening time is COALESCE(spotify_plays.ms_played, track_metadata.duration_ms).
-- Export plays keep their real ms_played; API plays count the full track length. Every played
-- track_uri gets a track_metadata row (scripts/enrich_track_metadata.py), so duration_ms covers them.
-- `tracks.duration_ms` (0001, last.fm era) is not used: it is keyed by spotify_id and almost empty
-- for recent plays. Same expression as Streamlit (lib/listening_time.py), so both report the same hours.
--
-- Replace-only, no data in `public` is touched:
--   * hub.rebuild_days: same three day tables, with the fallback.
--   * hub.mv_track_stats: dropped and recreated (its ms column) with both indexes.
--     The other MVs need no change: mv_totals reads hub.daily_listening; the rest have no ms.
--   * hub.refresh_rollups: also re-rolls the days of NULL-ms plays whose track_metadata was
--     enriched since the last refresh (enrichment runs as a separate job after the ingest, so
--     without this a late-evening play would count 0 ms until the daily full rebuild).
--   * Ends with a full rebuild so existing rows are corrected straight away.
-- 0023 itself is unchanged (already applied in production).

BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE OR REPLACE FUNCTION hub.rebuild_days(p_from date) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  t_from timestamptz := CASE WHEN p_from IS NULL THEN '-infinity'::timestamptz
                             ELSE (p_from::timestamp AT TIME ZONE 'Europe/Amsterdam') END;
BEGIN
  DELETE FROM hub.daily_listening WHERE p_from IS NULL OR d >= p_from;
  INSERT INTO hub.daily_listening (d, plays, ms, tracks)
  SELECT (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date, count(*),
         coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0), count(DISTINCT sp.track_uri)
  FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
  WHERE sp.track_uri IS NOT NULL AND sp.played_at >= t_from GROUP BY 1;

  DELETE FROM hub.day_track WHERE p_from IS NULL OR d >= p_from;
  INSERT INTO hub.day_track (d, artist, track, plays, track_uri, ms)
  SELECT (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date, coalesce(sp.artist_name, ''), coalesce(sp.track_name, ''),
         count(*), min(sp.track_uri), coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0)
  FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
  WHERE sp.track_uri IS NOT NULL AND sp.played_at >= t_from GROUP BY 1, 2, 3;

  DELETE FROM hub.behaviour_daily WHERE p_from IS NULL OR d >= p_from;
  INSERT INTO hub.behaviour_daily (d, platform_family, reason_end, shuffle, plays, ms)
  SELECT (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date,
         CASE
           WHEN sp.platform LIKE '%OS X%' OR sp.platform LIKE '%Mac OS%' OR sp.platform LIKE '%macOS%' THEN 'Mac'
           WHEN sp.platform LIKE '%iOS%' OR sp.platform LIKE '%iPhone%' OR sp.platform LIKE '%iPad%' THEN 'iOS'
           WHEN sp.platform LIKE '%Android%' THEN 'Android'
           WHEN sp.platform LIKE '%Windows%' THEN 'Windows'
           WHEN sp.platform LIKE '%WebPlayer%' OR sp.platform ILIKE '%web%' THEN 'Web'
           WHEN sp.platform IS NULL OR sp.platform = '' THEN 'Unknown'
           ELSE 'Other'
         END,
         coalesce(sp.reason_end, ''),
         (CASE WHEN sp.shuffle THEN 1 WHEN NOT sp.shuffle THEN 0 ELSE -1 END)::smallint,
         count(*), coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0)
  FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
  WHERE sp.track_uri IS NOT NULL AND sp.played_at >= t_from GROUP BY 1, 2, 3, 4;
END
$$;

-- Same definition as 0023 except the ms column. Nothing depends on it (hub.home_payload and the
-- hub's queries reference it by name at run time), so DROP + CREATE is safe.
DROP MATERIALIZED VIEW hub.mv_track_stats;
CREATE MATERIALIZED VIEW hub.mv_track_stats AS
  SELECT sp.track_uri,
         count(*)::int                                                              AS plays,
         min(sp.played_at)                                                          AS first_played_at,
         max(sp.played_at)                                                          AS last_played_at,
         count(*) FILTER (WHERE sp.played_at >= now() - interval '30 days')::int     AS plays_30d,
         count(*) FILTER (WHERE sp.played_at >= now() - interval '365 days')::int    AS plays_365d,
         count(*) FILTER (WHERE sp.reason_end = 'fwdbtn')::int                      AS skips,
         coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0)::bigint           AS ms,
         coalesce(max(sp.track_name), '')                                           AS track_name,
         coalesce(max(sp.artist_name), '')                                          AS artist_name,
         coalesce(max(sp.album_name), '')                                           AS album_name
  FROM spotify_plays sp
  LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
  WHERE sp.track_uri IS NOT NULL
  GROUP BY 1;
CREATE UNIQUE INDEX mv_track_stats_uri ON hub.mv_track_stats (track_uri);
CREATE INDEX mv_track_stats_plays ON hub.mv_track_stats (plays DESC);

-- As 0023, plus: days holding NULL-ms plays whose duration arrived (track_metadata enriched)
-- since the last refresh are re-rolled too.
CREATE OR REPLACE FUNCTION hub.refresh_rollups(p_full boolean DEFAULT false) RETURNS jsonb
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
  v_enr  date;
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
    SELECT min((sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date) INTO v_enr
    FROM track_metadata tm JOIN spotify_plays sp ON sp.track_uri = tm.track_uri
    WHERE tm.enriched_at > st.refreshed_at AND sp.ms_played IS NULL;
    v_from := least(v_from, v_enr);   -- least() ignores NULLs
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
  'Refreshes the Rotor stats rollups (0023, 0026): day tables incrementally (full once a day or with p_full; also days whose durations were enriched since the last refresh), MVs concurrently. Called at the end of scripts/ingest_spotify_recent.py.';

-- The recreated view is new: repeat 0023's lock-out of Supabase's API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA hub FROM anon';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hub FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA hub FROM authenticated';
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hub FROM authenticated';
  END IF;
END
$$;

-- Recompute everything with the fallback (≈ 11 s on 440k plays).
SELECT hub.refresh_rollups(true);

INSERT INTO migrations_applied (number, name) VALUES (26, 'rollups_duration_fallback');

COMMIT;
