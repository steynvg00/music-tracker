-- 0016: playlist_rank_history — weekly rank snapshots for rank-change arrows (v0.66).
--
-- One row per (playlist_id, track_uri) per weekly snapshot. The weekly digest diffs
-- the latest snapshot against the previous one to render ↑/↓/—/★NEW arrows. Only the
-- rank-tracked updating Top playlists are written here (Top 100 this year, Top 100
-- all-time, Top 50 last 30 days) — snapshots don't move so they're not tracked.

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE TABLE playlist_rank_history (
  playlist_id TEXT NOT NULL,
  track_uri TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  rank INT NOT NULL,
  PRIMARY KEY (playlist_id, track_uri, snapshot_at)
);

CREATE INDEX idx_playlist_rank_history_lookup
  ON playlist_rank_history (playlist_id, snapshot_at DESC);
