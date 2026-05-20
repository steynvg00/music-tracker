CREATE OR REPLACE VIEW unified_plays AS
SELECT
    played_at,
    artist_name AS artist,
    track_name  AS track,
    album_name  AS album
FROM spotify_plays
WHERE track_uri IS NOT NULL;

-- Notes:
-- This view exposes spotify_plays in the same shape as the old scrobbles JOIN result.
-- Filters to music plays only (excludes podcast/audiobook rows).
-- Used by app.py tabs 1-9 as the primary play history source.
-- Tab 10 (Spotify) continues to read spotify_plays directly for rich-field stats.
