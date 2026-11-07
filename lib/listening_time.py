"""Listening time per play (v0.83, migration 0026).

`spotify_plays.ms_played` is only known for plays from the Extended Streaming History export.
Plays ingested from the recently-played API carry no ms_played (NULL since migration 0005), so a
plain SUM(ms_played) counts them as zero listening time. Since the switch to API ingest that is
every recent play, and "hours this month" read 0.

Fallback, in order:
  1. spotify_plays.ms_played: what was actually played (export plays).
  2. track_metadata.duration_ms: the full track length (API plays). Every played track_uri gets a
     track_metadata row from scripts/enrich_track_metadata.py, so this covers API plays once
     they are enriched.
  3. nothing (0): unenriched tracks.

The hub rollups use the same expression (migrations/0026_rollups_duration_fallback.sql,
hub/src/lib/server/home.ts). Since v1.0 (Streamlit retired) this module is the parity reference:
tests/test_hours_duration_fallback.py and E2E R3-3 check that Rotor's hours equal these queries.

Use these with `spotify_plays sp` + DURATION_JOIN.
"""

PLAY_MS = "COALESCE(sp.ms_played, tm.duration_ms)"
DURATION_JOIN = "LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri"

# Streamlit Spotify tab, overview row.
SPOTIFY_OVERVIEW_SQL = f"""
    SELECT
        COUNT(*) AS total_plays,
        ROUND(COALESCE(SUM({PLAY_MS}), 0) / 3600000.0, 1) AS total_hours,
        MIN((sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date) AS first_d,
        MAX((sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date) AS last_d,
        COUNT(DISTINCT sp.track_uri) AS distinct_tracks
    FROM spotify_plays sp
    {DURATION_JOIN}
    WHERE sp.track_uri IS NOT NULL
"""

# Streamlit Spotify tab, "Listening time" by year.
SPOTIFY_HOURS_BY_YEAR_SQL = f"""
    SELECT
        EXTRACT(YEAR FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year_d,
        ROUND(COALESCE(SUM({PLAY_MS}), 0) / 3600000.0, 1) AS hours
    FROM spotify_plays sp
    {DURATION_JOIN}
    WHERE sp.track_uri IS NOT NULL
    GROUP BY year_d
    ORDER BY year_d
"""

# Streamlit album lookup summary (one %s parameter: the album name).
ALBUM_SUMMARY_SQL = f"""
    SELECT
        COUNT(*) AS total_plays,
        COUNT(DISTINCT sp.track_uri) AS unique_tracks,
        MIN(sp.played_at) AS first_listen,
        MAX(sp.played_at) AS last_listen,
        ROUND(COALESCE(SUM({PLAY_MS}), 0) / 3600000.0, 2) AS total_listening_hours
    FROM spotify_plays sp
    {DURATION_JOIN}
    WHERE sp.album_name = %s
      AND sp.artist_name IS NOT NULL
      AND sp.track_uri IS NOT NULL
"""
