-- ISRC for cross-URI recording identity
ALTER TABLE track_metadata
  ADD COLUMN isrc text,
  ADD COLUMN album_type text,
  ADD COLUMN canonical_track_uri text;

-- Index for ISRC-based grouping queries
CREATE INDEX idx_track_metadata_isrc ON track_metadata (isrc) WHERE isrc IS NOT NULL;

-- Index for canonical lookups (v0.58+ consumer queries will use this)
CREATE INDEX idx_track_metadata_canonical ON track_metadata (canonical_track_uri);

COMMENT ON COLUMN track_metadata.isrc IS 'International Standard Recording Code from Spotify /tracks external_ids. Same ISRC = same underlying recording across multiple Spotify track_uri values.';
COMMENT ON COLUMN track_metadata.album_type IS 'Spotify album.album_type: album, single, or compilation. Used to select canonical track when multiple URIs share an ISRC.';
COMMENT ON COLUMN track_metadata.canonical_track_uri IS 'The canonical track_uri this recording resolves to. Self-referential for tracks with no duplicates. Computed from ISRC groups with album_type preference (album > compilation > single).';
