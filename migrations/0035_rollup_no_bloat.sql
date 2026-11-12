-- 0035: rollup_no_bloat — Rotor v0.92: the day rollups stop rewriting themselves.
--
-- Problem (production, Nov 2026): hub.day_track grew 124 → 142 MB in 5 days. hub.rebuild_days(NULL),
-- the daily full rebuild inside hub.refresh_rollups, DELETEd every row of the three day tables and
-- INSERTed them again in one transaction. Every row became a dead tuple, the new copies could not
-- reuse that space (same transaction), and autovacuum only makes space reusable, it never shrinks the
-- file. So the table grew by about one full copy per day until vacuum caught up. VACUUM FULL brought
-- it back to 72 MB once; this makes sure it can't regrow.
--
-- Fix: a DIFF-MERGE instead of delete + insert. Each day table's new aggregate is computed once (a
-- MATERIALIZED CTE) and applied in ONE statement:
--   DELETE the keys that no longer exist · UPDATE only rows whose values changed (IS DISTINCT FROM)
--   · INSERT keys that are new.
-- A day whose plays didn't change produces no write and no dead tuple. A full rebuild over an unchanged
-- history writes nothing; the */30 incremental refresh rewrites only the rows of the days that really
-- changed (today, plus late enrichment). Readers are never blocked: only row locks on changed rows,
-- MVCC as before, no table lock.
--
-- Rejected: rebuild into a fresh table and swap. It needs an ACCESS EXCLUSIVE lock for the rename
-- (blocks every reader for its duration), rewrites the whole 70 MB table plus 4 indexes and its WAL
-- every day, and hub.mv_artist_first / hub.mv_track_first depend on hub.day_track, so they would have
-- to be dropped and recreated each time.
--
-- The materialized views were already diff-based: REFRESH MATERIALIZED VIEW CONCURRENTLY computes the
-- new result and applies only the changed rows, so they bloat in proportion to what changed (mostly
-- mv_track_stats' 30-day counters), which autovacuum keeps up with. Unchanged here.
--
-- Also new: once a day (the full refresh) a size snapshot of the 10 largest tables is kept in
-- hub.rollup_state.detail->'sizes' (last 14 days), for Settings › Data health's "grew > 10% in a
-- week" warning. No new table: the existing jsonb column.
--
-- CREATE OR REPLACE only: hub.rebuild_days keeps its signature (now a wrapper), hub.refresh_rollups is
-- replaced, hub.merge_days is new. No data is touched by applying it: the next refresh uses the new
-- code. Applies after 0034 (and works with or without 0025 / 0033).

BEGIN;

SET LOCAL lock_timeout = '15s';

-- The diff-merge for local days >= p_from (NULL = all). Returns rows deleted / updated / inserted per table.
CREATE OR REPLACE FUNCTION hub.merge_days(p_from date) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  t_from timestamptz := CASE WHEN p_from IS NULL THEN '-infinity'::timestamptz
                             ELSE (p_from::timestamp AT TIME ZONE 'Europe/Amsterdam') END;
  d1 bigint; u1 bigint; i1 bigint;
  d2 bigint; u2 bigint; i2 bigint;
  d3 bigint; u3 bigint; i3 bigint;
BEGIN
  -- hub.daily_listening (key d)
  WITH n AS MATERIALIZED (
    SELECT (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS d, count(*)::int AS plays,
           coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0)::bigint AS ms, count(DISTINCT sp.track_uri)::int AS tracks
    FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
    WHERE sp.track_uri IS NOT NULL AND sp.played_at >= t_from GROUP BY 1
  ),
  del AS (
    DELETE FROM hub.daily_listening t WHERE (p_from IS NULL OR t.d >= p_from)
      AND NOT EXISTS (SELECT 1 FROM n WHERE n.d = t.d) RETURNING 1
  ),
  upd AS (
    UPDATE hub.daily_listening t SET plays = n.plays, ms = n.ms, tracks = n.tracks FROM n
    WHERE n.d = t.d AND (t.plays, t.ms, t.tracks) IS DISTINCT FROM (n.plays, n.ms, n.tracks) RETURNING 1
  ),
  ins AS (
    INSERT INTO hub.daily_listening (d, plays, ms, tracks)
    SELECT n.d, n.plays, n.ms, n.tracks FROM n WHERE NOT EXISTS (SELECT 1 FROM hub.daily_listening t WHERE t.d = n.d) RETURNING 1
  )
  SELECT (SELECT count(*) FROM del), (SELECT count(*) FROM upd), (SELECT count(*) FROM ins) INTO d1, u1, i1;

  -- hub.day_track (key d, artist, track)
  WITH n AS MATERIALIZED (
    SELECT (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS d, coalesce(sp.artist_name, '') AS artist, coalesce(sp.track_name, '') AS track,
           count(*)::int AS plays, min(sp.track_uri) AS track_uri, coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0)::bigint AS ms
    FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
    WHERE sp.track_uri IS NOT NULL AND sp.played_at >= t_from GROUP BY 1, 2, 3
  ),
  del AS (
    DELETE FROM hub.day_track t WHERE (p_from IS NULL OR t.d >= p_from)
      AND NOT EXISTS (SELECT 1 FROM n WHERE n.d = t.d AND n.artist = t.artist AND n.track = t.track) RETURNING 1
  ),
  upd AS (
    UPDATE hub.day_track t SET plays = n.plays, track_uri = n.track_uri, ms = n.ms FROM n
    WHERE n.d = t.d AND n.artist = t.artist AND n.track = t.track
      AND (t.plays, t.track_uri, t.ms) IS DISTINCT FROM (n.plays, n.track_uri, n.ms) RETURNING 1
  ),
  ins AS (
    INSERT INTO hub.day_track (d, artist, track, plays, track_uri, ms)
    SELECT n.d, n.artist, n.track, n.plays, n.track_uri, n.ms FROM n
    WHERE NOT EXISTS (SELECT 1 FROM hub.day_track t WHERE t.d = n.d AND t.artist = n.artist AND t.track = n.track) RETURNING 1
  )
  SELECT (SELECT count(*) FROM del), (SELECT count(*) FROM upd), (SELECT count(*) FROM ins) INTO d2, u2, i2;

  -- hub.behaviour_daily (key d, platform_family, reason_end, shuffle)
  WITH n AS MATERIALIZED (
    SELECT (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS d,
           CASE
             WHEN sp.platform LIKE '%OS X%' OR sp.platform LIKE '%Mac OS%' OR sp.platform LIKE '%macOS%' THEN 'Mac'
             WHEN sp.platform LIKE '%iOS%' OR sp.platform LIKE '%iPhone%' OR sp.platform LIKE '%iPad%' THEN 'iOS'
             WHEN sp.platform LIKE '%Android%' THEN 'Android'
             WHEN sp.platform LIKE '%Windows%' THEN 'Windows'
             WHEN sp.platform LIKE '%WebPlayer%' OR sp.platform ILIKE '%web%' THEN 'Web'
             WHEN sp.platform IS NULL OR sp.platform = '' THEN 'Unknown'
             ELSE 'Other'
           END AS platform_family,
           coalesce(sp.reason_end, '') AS reason_end,
           (CASE WHEN sp.shuffle THEN 1 WHEN NOT sp.shuffle THEN 0 ELSE -1 END)::smallint AS shuffle,
           count(*)::int AS plays, coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0)::bigint AS ms
    FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
    WHERE sp.track_uri IS NOT NULL AND sp.played_at >= t_from GROUP BY 1, 2, 3, 4
  ),
  del AS (
    DELETE FROM hub.behaviour_daily t WHERE (p_from IS NULL OR t.d >= p_from)
      AND NOT EXISTS (SELECT 1 FROM n WHERE n.d = t.d AND n.platform_family = t.platform_family AND n.reason_end = t.reason_end AND n.shuffle = t.shuffle)
    RETURNING 1
  ),
  upd AS (
    UPDATE hub.behaviour_daily t SET plays = n.plays, ms = n.ms FROM n
    WHERE n.d = t.d AND n.platform_family = t.platform_family AND n.reason_end = t.reason_end AND n.shuffle = t.shuffle
      AND (t.plays, t.ms) IS DISTINCT FROM (n.plays, n.ms) RETURNING 1
  ),
  ins AS (
    INSERT INTO hub.behaviour_daily (d, platform_family, reason_end, shuffle, plays, ms)
    SELECT n.d, n.platform_family, n.reason_end, n.shuffle, n.plays, n.ms FROM n
    WHERE NOT EXISTS (SELECT 1 FROM hub.behaviour_daily t WHERE t.d = n.d AND t.platform_family = n.platform_family AND t.reason_end = n.reason_end AND t.shuffle = n.shuffle)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM del), (SELECT count(*) FROM upd), (SELECT count(*) FROM ins) INTO d3, u3, i3;

  RETURN jsonb_build_object(
    'daily_listening', jsonb_build_object('deleted', d1, 'updated', u1, 'inserted', i1),
    'day_track', jsonb_build_object('deleted', d2, 'updated', u2, 'inserted', i2),
    'behaviour_daily', jsonb_build_object('deleted', d3, 'updated', u3, 'inserted', i3));
END
$$;

COMMENT ON FUNCTION hub.merge_days(date) IS
  'v0.92 (0035): diff-merge of the day rollups for local days >= p_from (NULL = all). Unchanged rows are not written, so a full rebuild leaves no dead tuples.';

-- Same signature as 0023/0026 (other callers keep working), now without delete + insert.
CREATE OR REPLACE FUNCTION hub.rebuild_days(p_from date) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM hub.merge_days(p_from);
END
$$;

-- As 0026, with the diff-merge (its row counts in the result) and the daily size snapshot.
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
  sizes jsonb;
  today date := (now() AT TIME ZONE 'Europe/Amsterdam')::date;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('hub.refresh_rollups')) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;
  SELECT * INTO st FROM hub.rollup_state;
  SELECT max(ingested_at) INTO mark FROM spotify_plays;
  full_ := p_full OR st.ingested_mark IS NULL OR st.full_rebuilt_at IS NULL OR st.full_rebuilt_at < now() - interval '24 hours';

  t := clock_timestamp();
  IF full_ THEN
    out := out || jsonb_build_object('days', 'full', 'merge', hub.merge_days(NULL));
  ELSE
    SELECT min((played_at AT TIME ZONE 'Europe/Amsterdam')::date) INTO v_from
    FROM spotify_plays WHERE ingested_at > st.ingested_mark AND track_uri IS NOT NULL;
    SELECT min((sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date) INTO v_enr
    FROM track_metadata tm JOIN spotify_plays sp ON sp.track_uri = tm.track_uri
    WHERE tm.enriched_at > st.refreshed_at AND sp.ms_played IS NULL;
    v_from := least(v_from, v_enr);   -- least() ignores NULLs
    IF v_from IS NOT NULL THEN out := out || jsonb_build_object('merge', hub.merge_days(v_from)); END IF;
    out := out || jsonb_build_object('days', coalesce(v_from::text, 'unchanged'));
  END IF;
  out := out || jsonb_build_object('days_ms', round(extract(epoch FROM clock_timestamp() - t) * 1000)::int);

  FOREACH v IN ARRAY ARRAY['mv_track_stats', 'mv_artist_stats', 'mv_artist_first', 'mv_track_first', 'mv_hour_dow', 'mv_totals']
  LOOP
    t := clock_timestamp();
    EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY hub.%I', v);
    out := out || jsonb_build_object(v, round(extract(epoch FROM clock_timestamp() - t) * 1000)::int);
  END LOOP;

  -- Size history for Data health (one snapshot per local day, the last 14 days kept).
  sizes := coalesce(st.detail -> 'sizes', '[]'::jsonb);
  IF jsonb_typeof(sizes) <> 'array' THEN sizes := '[]'::jsonb; END IF;
  IF full_ OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(sizes) e WHERE e ->> 'd' = today::text) THEN
    SELECT coalesce(jsonb_agg(e ORDER BY e ->> 'd'), '[]'::jsonb) INTO sizes
    FROM jsonb_array_elements(sizes) e
    WHERE e ->> 'd' <> today::text AND (e ->> 'd')::date > today - 14;
    sizes := sizes || jsonb_build_array(jsonb_build_object('d', today, 't', (
      SELECT jsonb_object_agg(name, bytes) FROM (
        SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name,
               pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'm') AND n.nspname IN ('public', 'hub')
        ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10) s)));
  END IF;

  total := round(extract(epoch FROM clock_timestamp() - t0) * 1000)::int;
  UPDATE hub.rollup_state
     SET refreshed_at = now(), took_ms = total, detail = out || jsonb_build_object('sizes', sizes),
         ingested_mark = coalesce(mark, ingested_mark),
         full_rebuilt_at = CASE WHEN full_ THEN now() ELSE full_rebuilt_at END;
  RETURN out || jsonb_build_object('total_ms', total);
END
$$;

COMMENT ON FUNCTION hub.refresh_rollups(boolean) IS
  'Refreshes the Rotor stats rollups (0023, 0026, 0035): day tables by diff-merge (incremental, full once a day; unchanged rows are never rewritten), MVs concurrently, a daily size snapshot in rollup_state.detail->sizes. Called at the end of scripts/ingest_spotify_recent.py.';

-- New function: repeat 0023's lock-out of Supabase's API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hub FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hub FROM authenticated';
  END IF;
END
$$;

INSERT INTO migrations_applied (number, name) VALUES (35, 'rollup_no_bloat');

COMMIT;
