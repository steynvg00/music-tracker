-- 0021: daily_picks — Rotor's daily pick: candidates, per-day state, rotation history (v0.81, R1).
--
-- scripts/generate_daily_picks.py writes 5 candidates per Europe/Amsterdam calendar
-- day (cron 30 4 * * *), interleaving generated picks (Python recipes over your own
-- history) with existing playlists from the mirror (read + play only). "Shuffle the
-- deck" appends ranks 6..10, 11..15, … for the same day (--reseed).
--
-- The hub only reads candidates. Rotate/select moves daily_pick_state.current_rank
-- (no Spotify call). Play writes a generated pick into the managed playlist
-- 'Daily pick · Auto 🤖🔄' through the write guard, or plays an existing playlist
-- as-is. playlist_rotation_history records suggestions and plays, because
-- spotify_plays has no playlist context column.

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE TABLE daily_pick_candidates (
  pick_date    date     NOT NULL,              -- Europe/Amsterdam calendar day
  rank         smallint NOT NULL CHECK (rank >= 1),
  kind         text     NOT NULL CHECK (kind IN ('generated', 'existing_playlist')),
  recipe       text,                           -- e.g. 'forgotten_gems' (generated only)
  params       jsonb    NOT NULL DEFAULT '{}'::jsonb,  -- recipe parameters, e.g. {"year": 2021}
  playlist_id  text REFERENCES spotify_playlists (playlist_id),  -- existing_playlist only
  title        text     NOT NULL,
  reason       text     NOT NULL,              -- "38 liked tracks you haven't played in 6+ months"
  track_uris   text[],                         -- generated only, ≤ 100 (one replace call)
  duration_ms  bigint,                         -- generated: estimated total length
  score        numeric(6,4),
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pick_date, rank),
  CHECK (
    (kind = 'generated'
       AND recipe IS NOT NULL
       AND playlist_id IS NULL
       AND track_uris IS NOT NULL
       AND cardinality(track_uris) BETWEEN 1 AND 100)
    OR
    (kind = 'existing_playlist'
       AND playlist_id IS NOT NULL
       AND track_uris IS NULL)
  )
);

CREATE INDEX idx_daily_pick_candidates_playlist
  ON daily_pick_candidates (playlist_id, pick_date DESC)
  WHERE playlist_id IS NOT NULL;

CREATE TABLE daily_pick_state (
  pick_date           date PRIMARY KEY,
  current_rank        smallint NOT NULL DEFAULT 1,
  played_rank         smallint,
  played_at           timestamptz,
  rotated             smallint[] NOT NULL DEFAULT '{}',
  reseed_requested_at timestamptz,             -- "Shuffle the deck" dispatched, cleared by the generator
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE playlist_rotation_history (
  playlist_id       text PRIMARY KEY REFERENCES spotify_playlists (playlist_id),
  last_suggested_on date,                      -- became the current pick (hub)
  last_played_on    date,                      -- played via Rotor (hub)
  times_suggested   int NOT NULL DEFAULT 0,
  times_played      int NOT NULL DEFAULT 0,
  rotation_score    numeric(6,4),              -- written by the generator on every run
  scored_at         timestamptz
);

CREATE INDEX idx_playlist_rotation_history_score
  ON playlist_rotation_history (rotation_score DESC NULLS LAST);

ALTER TABLE daily_pick_candidates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_pick_state          ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlist_rotation_history ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (21, 'daily_picks');
