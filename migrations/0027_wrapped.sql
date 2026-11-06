-- 0027: wrapped — Rotor R6: Rotor Wrapped, a full-calendar-year review (v0.86).
--
-- Additive, EXCEPT ONE STATEMENT: the hub_jobs.kind CHECK constraint is replaced by a WIDER one
-- that adds 'wrapped_build'. Every existing row stays valid; nothing is dropped or renamed. The new
-- list also contains R5's 'mix_relay' (migration 0025), so this file applies cleanly with or without
-- 0025 and never invalidates a row 0025 may have written. (If 0025 is ever applied AFTER this file,
-- its own CHECK would drop 'wrapped_build': re-check 0025 before merging R5.)
--
-- Everything else is new:
--   * wrapped_snapshots: one FROZEN payload per past year. Written only by hub.wrapped_freeze(),
--     which never overwrites; a trigger refuses UPDATE. DELETE a row by hand to rebuild a year.
--   * hub.wrapped_payload(year, through): the whole story as jsonb, from the R3 rollups
--     (hub.day_track, hub.daily_listening, hub.mv_*_first; hours include 0026's duration
--     fallback) + one year of spotify_plays (listening clock, "≈" count) + badge_events.
--     Live for "Wrapped so far" (through = today), frozen for past years (through = 31 Dec).
--   * hub.wrapped_freeze(year, source): builds + stores a past year once.
--   * Two indexes on hub.day_track for the comeback look-ups (last play before the year).
--
-- Requires 0023 + 0026. Does not require 0024 or 0025.

BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

-- ── The one non-additive statement: widen hub_jobs.kind ──────────────────────
ALTER TABLE hub_jobs DROP CONSTRAINT IF EXISTS hub_jobs_kind_check,
  ADD CONSTRAINT hub_jobs_kind_check
  CHECK (kind IN ('reseed_daily_pick', 'refresh_managed', 'push_test', 'mix_relay', 'wrapped_build'));

-- ── Frozen snapshots ─────────────────────────────────────────────────────────
CREATE TABLE wrapped_snapshots (
  year            int         PRIMARY KEY CHECK (year BETWEEN 2000 AND 2100),
  payload         jsonb       NOT NULL,
  payload_version int         NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  build_ms        int         NOT NULL,
  source          text        NOT NULL CHECK (source IN ('daily', 'job', 'hub'))
);
ALTER TABLE wrapped_snapshots ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION hub.wrapped_snapshots_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wrapped_snapshots are frozen: % stays as built (delete the row to rebuild it)', OLD.year;
END
$$;
CREATE TRIGGER wrapped_snapshots_no_update BEFORE UPDATE ON wrapped_snapshots
  FOR EACH ROW EXECUTE FUNCTION hub.wrapped_snapshots_frozen();

-- ── Comeback look-ups: "when did I last play this before the year started?" ──
CREATE INDEX day_track_artist_d ON hub.day_track (artist, d);
CREATE INDEX day_track_artist_track_d ON hub.day_track (artist, track, d);

-- ── The payload ──────────────────────────────────────────────────────────────
-- Payload version 1. Keys are camelCase (read as-is by hub/src/lib/shared/wrapped.ts).
-- Lists use the artist/track TEXT, like Stats › Year in review and Streamlit's Year in review.
CREATE FUNCTION hub.wrapped_payload(p_year int, p_through date) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH b AS (
    SELECT make_date(p_year, 1, 1) AS y0,
           least(make_date(p_year, 12, 31), p_through) AS y1,
           make_date(p_year - 1, 1, 1) AS p0,
           least(make_date(p_year - 1, 12, 31), (p_through - interval '1 year')::date) AS p1
  ),
  yd AS (SELECT dl.* FROM hub.daily_listening dl, b WHERE dl.d BETWEEN b.y0 AND b.y1),
  yt AS (SELECT dt.* FROM hub.day_track dt, b WHERE dt.d BETWEEN b.y0 AND b.y1),
  ytrack AS (
    SELECT artist, track, min(track_uri) AS uri, sum(plays)::int AS plays, sum(ms)::bigint AS ms, min(d) AS first_d
    FROM yt GROUP BY artist, track
  ),
  yart AS (
    SELECT artist, sum(plays)::int AS plays, sum(ms)::bigint AS ms, count(DISTINCT track)::int AS tracks, min(d) AS first_d
    FROM yt WHERE artist <> '' GROUP BY artist
  ),
  top_tracks AS (
    SELECT row_number() OVER (ORDER BY plays DESC, ms DESC, artist, track)::int AS rank, * FROM ytrack
    ORDER BY plays DESC, ms DESC, artist, track LIMIT 100
  ),
  top_artists AS (
    SELECT row_number() OVER (ORDER BY plays DESC, ms DESC, artist)::int AS rank, * FROM yart
    ORDER BY plays DESC, ms DESC, artist LIMIT 100
  ),
  -- First-ever plays (all history) that fall in this year.
  new_artists AS (
    SELECT a.artist, a.plays, a.first_d FROM hub.mv_artist_first f
    JOIN yart a ON a.artist = f.artist, b
    WHERE f.first_d BETWEEN b.y0 AND b.y1
  ),
  new_tracks AS (
    SELECT t.artist, t.track, t.uri, t.plays, t.first_d FROM hub.mv_track_first f
    JOIN ytrack t ON t.artist = f.artist AND t.track = f.track, b
    WHERE f.first_d BETWEEN b.y0 AND b.y1 AND t.artist <> ''
  ),
  -- Comebacks: played this year, and the last play before the year is ≥ 365 days before the
  -- first play this year (≥ 12 months away).
  cb_artists AS (
    SELECT a.artist, a.plays, a.first_d, p.prev, (a.first_d - p.prev) AS gap
    FROM yart a, b,
    LATERAL (SELECT max(x.d) AS prev FROM hub.day_track x WHERE x.artist = a.artist AND x.d < b.y0) p
    WHERE p.prev IS NOT NULL AND a.first_d - p.prev >= 365
  ),
  cb_tracks AS (
    SELECT t.artist, t.track, t.uri, t.plays, t.first_d, p.prev, (t.first_d - p.prev) AS gap
    FROM ytrack t, b,
    LATERAL (SELECT max(x.d) AS prev FROM hub.day_track x WHERE x.artist = t.artist AND x.track = t.track AND x.d < b.y0) p
    WHERE t.artist <> '' AND p.prev IS NOT NULL AND t.first_d - p.prev >= 365
  ),
  runs AS (
    SELECT min(d) AS start_d, max(d) AS end_d, count(*)::int AS len
    FROM (SELECT d, d - (row_number() OVER (ORDER BY d))::int AS grp FROM yd) s GROUP BY grp
  ),
  longest AS (SELECT * FROM runs ORDER BY len DESC, end_d DESC LIMIT 1),
  big AS (SELECT d, plays, ms FROM yd ORDER BY plays DESC, ms DESC, d LIMIT 1),
  big_top AS (
    SELECT yt.artist, yt.track, yt.track_uri, yt.plays FROM yt, big WHERE yt.d = big.d
    ORDER BY yt.plays DESC, yt.artist, yt.track LIMIT 1
  ),
  months AS (
    SELECT extract(month FROM d)::int AS m, sum(plays)::int AS plays, sum(ms)::bigint AS ms
    FROM yd GROUP BY 1
  ),
  -- One pass over this year's plays: hour × weekday + how many plays had no ms_played.
  clock AS (
    SELECT extract(dow  FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int AS dow,
           extract(hour FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int AS hour,
           count(*)::int AS plays,
           count(*) FILTER (WHERE sp.ms_played IS NULL)::int AS no_ms
    FROM spotify_plays sp, b
    WHERE sp.track_uri IS NOT NULL
      AND sp.played_at >= (b.y0::timestamp AT TIME ZONE 'Europe/Amsterdam')
      AND sp.played_at <  ((b.y1 + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam')
    GROUP BY 1, 2
  ),
  badges AS (
    SELECT be.entity_type, be.entity_id, be.badge_type, be.awarded_at,
           CASE WHEN be.entity_type = 'track' THEN ts.track_name ELSE ast.artist_name END AS name,
           CASE WHEN be.entity_type = 'track' THEN ts.artist_name END AS artist
    FROM badge_events be
    LEFT JOIN hub.mv_track_stats ts ON be.entity_type = 'track' AND ts.track_uri = be.entity_id
    LEFT JOIN hub.mv_artist_stats ast ON be.entity_type = 'artist' AND ast.artist_id = be.entity_id, b
    WHERE be.awarded_at >= (b.y0::timestamp AT TIME ZONE 'Europe/Amsterdam')
      AND be.awarded_at <  ((b.y1 + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam')
  ),
  prev AS (
    SELECT coalesce(sum(dl.plays), 0)::int AS plays, coalesce(sum(dl.ms), 0)::bigint AS ms, count(*)::int AS days
    FROM hub.daily_listening dl, b WHERE dl.d BETWEEN b.p0 AND b.p1
  ),
  prev_uniq AS (
    SELECT count(DISTINCT dt.artist) FILTER (WHERE dt.artist <> '')::int AS artists,
           count(DISTINCT (dt.artist, dt.track))::int AS tracks
    FROM hub.day_track dt, b WHERE dt.d BETWEEN b.p0 AND b.p1
  ),
  prev_new AS (
    SELECT count(*)::int AS artists FROM hub.mv_artist_first f, b WHERE f.first_d BETWEEN b.p0 AND b.p1 AND f.artist <> ''
  ),
  tot AS (
    SELECT coalesce(sum(plays), 0)::int AS plays, coalesce(sum(ms), 0)::bigint AS ms, count(*)::int AS days,
           min(d) AS first_d, max(d) AS last_d
    FROM yd
  )
  SELECT jsonb_build_object(
    'version', 1,
    'year', p_year,
    'through', (SELECT y1 FROM b),
    'live', p_through < make_date(p_year, 12, 31),
    'generatedAt', now(),
    'totals', (SELECT jsonb_build_object(
        'plays', tot.plays, 'ms', tot.ms, 'days', tot.days, 'firstDay', tot.first_d, 'lastDay', tot.last_d,
        'tracks', (SELECT count(*) FROM ytrack)::int, 'artists', (SELECT count(*) FROM yart)::int,
        'noMsPlays', coalesce((SELECT sum(no_ms) FROM clock), 0)::int) FROM tot),
    'topTracks', coalesce((SELECT jsonb_agg(jsonb_build_object('rank', rank, 'track', track, 'artist', artist, 'uri', uri,
        'plays', plays, 'ms', ms) ORDER BY rank) FROM top_tracks), '[]'::jsonb),
    'topArtists', coalesce((SELECT jsonb_agg(jsonb_build_object('rank', rank, 'artist', artist, 'plays', plays, 'ms', ms,
        'tracks', tracks) ORDER BY rank) FROM top_artists), '[]'::jsonb),
    'discoveries', jsonb_build_object(
        'artists', (SELECT count(*) FROM new_artists)::int,
        'tracks', (SELECT count(*) FROM new_tracks)::int,
        'topArtists', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'plays')::int DESC, x->>'artist') FROM (
            SELECT jsonb_build_object('artist', artist, 'plays', plays, 'firstDay', first_d) AS x FROM new_artists
            ORDER BY plays DESC, artist LIMIT 5) s), '[]'::jsonb),
        'topTracks', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'plays')::int DESC, x->>'track') FROM (
            SELECT jsonb_build_object('track', track, 'artist', artist, 'uri', uri, 'plays', plays, 'firstDay', first_d) AS x FROM new_tracks
            ORDER BY plays DESC, artist, track LIMIT 5) s), '[]'::jsonb)),
    'comebacks', jsonb_build_object(
        'artists', (SELECT count(*) FROM cb_artists)::int,
        'tracks', (SELECT count(*) FROM cb_tracks)::int,
        'topArtists', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'plays')::int DESC, x->>'artist') FROM (
            SELECT jsonb_build_object('artist', artist, 'plays', plays, 'lastBefore', prev, 'backOn', first_d, 'gapDays', gap) AS x
            FROM cb_artists ORDER BY plays DESC, artist LIMIT 5) s), '[]'::jsonb),
        'topTracks', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'plays')::int DESC, x->>'track') FROM (
            SELECT jsonb_build_object('track', track, 'artist', artist, 'uri', uri, 'plays', plays, 'lastBefore', prev, 'backOn', first_d, 'gapDays', gap) AS x
            FROM cb_tracks ORDER BY plays DESC, artist, track LIMIT 5) s), '[]'::jsonb)),
    'streak', (SELECT jsonb_build_object('days', len, 'from', start_d, 'to', end_d) FROM longest),
    'biggestDay', (SELECT jsonb_build_object('day', big.d, 'plays', big.plays, 'ms', big.ms,
        'top', (SELECT jsonb_build_object('track', track, 'artist', artist, 'uri', track_uri, 'plays', plays) FROM big_top)) FROM big),
    'clock', (SELECT jsonb_agg(row_v ORDER BY dow) FROM (
        SELECT g.dow, jsonb_agg(coalesce(c.plays, 0) ORDER BY h.hour) AS row_v
        FROM generate_series(0, 6) g(dow) CROSS JOIN generate_series(0, 23) h(hour)
        LEFT JOIN clock c ON c.dow = g.dow AND c.hour = h.hour
        GROUP BY g.dow) s),
    'months', (SELECT jsonb_agg(jsonb_build_object('month', mm.m, 'plays', coalesce(months.plays, 0), 'ms', coalesce(months.ms, 0)) ORDER BY mm.m)
        FROM generate_series(1, 12) mm(m) LEFT JOIN months ON months.m = mm.m),
    'badges', jsonb_build_object(
        'count', (SELECT count(*) FROM badges)::int,
        'byType', coalesce((SELECT jsonb_object_agg(badge_type, n) FROM (SELECT badge_type, count(*)::int AS n FROM badges GROUP BY 1) s), '{}'::jsonb),
        'items', coalesce((SELECT jsonb_agg(x ORDER BY x->>'awardedAt' DESC) FROM (
            SELECT jsonb_build_object('entityType', entity_type, 'entityId', entity_id, 'badgeType', badge_type,
                   'awardedAt', awarded_at, 'name', name, 'artist', artist) AS x
            FROM badges ORDER BY awarded_at DESC LIMIT 24) s), '[]'::jsonb)),
    'previous', (SELECT jsonb_build_object('year', p_year - 1, 'plays', prev.plays, 'ms', prev.ms, 'days', prev.days,
        'artists', prev_uniq.artists, 'tracks', prev_uniq.tracks, 'newArtists', prev_new.artists,
        'through', (SELECT p1 FROM b)) FROM prev, prev_uniq, prev_new)
  )
$$;

COMMENT ON FUNCTION hub.wrapped_payload(int, date) IS
  'Rotor Wrapped (0027): the year story as jsonb from the hub rollups. Live for the current year (through = today), frozen via hub.wrapped_freeze for past years.';

-- Build and store a past year once. Returns {year, created, generatedAt, buildMs}.
-- Never overwrites: a second call returns the existing snapshot's metadata with created = false.
CREATE FUNCTION hub.wrapped_freeze(p_year int, p_source text DEFAULT 'job') RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  this_year int := extract(year FROM now() AT TIME ZONE 'Europe/Amsterdam')::int;
  t0 timestamptz := clock_timestamp();
  pl jsonb;
  ms int;
  r wrapped_snapshots;
BEGIN
  IF p_year < 2017 OR p_year >= this_year THEN
    RAISE EXCEPTION 'Wrapped can be frozen for 2017 … % only (got %)', this_year - 1, p_year
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM wrapped_snapshots WHERE year = p_year;
  IF FOUND THEN
    RETURN jsonb_build_object('year', p_year, 'created', false, 'generatedAt', r.generated_at, 'buildMs', r.build_ms);
  END IF;
  pl := hub.wrapped_payload(p_year, make_date(p_year, 12, 31));
  ms := round(extract(epoch FROM clock_timestamp() - t0) * 1000)::int;
  INSERT INTO wrapped_snapshots (year, payload, payload_version, build_ms, source)
  VALUES (p_year, pl, (pl->>'version')::int, ms, p_source)
  ON CONFLICT (year) DO NOTHING
  RETURNING * INTO r;
  IF r.year IS NULL THEN  -- a concurrent build won the race
    SELECT * INTO r FROM wrapped_snapshots WHERE year = p_year;
    RETURN jsonb_build_object('year', p_year, 'created', false, 'generatedAt', r.generated_at, 'buildMs', r.build_ms);
  END IF;
  RETURN jsonb_build_object('year', p_year, 'created', true, 'generatedAt', r.generated_at, 'buildMs', r.build_ms);
END
$$;

COMMENT ON FUNCTION hub.wrapped_freeze(int, text) IS
  'Rotor Wrapped (0027): builds and stores one past year (2017 … last year) once; never overwrites.';

-- Same lock-out of Supabase's API roles as 0023/0026.
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

INSERT INTO migrations_applied (number, name) VALUES (27, 'wrapped');

COMMIT;
