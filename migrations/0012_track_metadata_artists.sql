-- Add artist arrays to track_metadata
ALTER TABLE track_metadata
  ADD COLUMN artist_ids text[],
  ADD COLUMN artist_names text[];

-- GIN indexes for fast array containment queries
-- (Phase 2 consumer queries will use WHERE 'artist_id' = ANY(artist_ids))
CREATE INDEX idx_track_metadata_artist_ids ON track_metadata USING GIN (artist_ids);
CREATE INDEX idx_track_metadata_artist_names ON track_metadata USING GIN (artist_names);

-- Comment for future readers
COMMENT ON COLUMN track_metadata.artist_ids IS 'Spotify artist IDs from /tracks API, in original order. Populated by lib/track_metadata.py enrichment.';
COMMENT ON COLUMN track_metadata.artist_names IS 'Spotify artist display names from /tracks API, parallel array to artist_ids.';
