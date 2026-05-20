-- v0.21: drop NOT NULL on ms_played since the Spotify recently-played API
-- doesn't return this field. Extended export re-imports backfill it later
-- via the ON CONFLICT DO UPDATE path in lib/spotify_history.py.
ALTER TABLE spotify_plays ALTER COLUMN ms_played DROP NOT NULL;
