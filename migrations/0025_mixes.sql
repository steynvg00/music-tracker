-- 0025: mixes — Rotor R5: mixed sessions (experimental, opt-in per device) (v0.85).
--
-- ⚠ ONE NON-ADDITIVE STATEMENT: the CHECK constraint on hub_jobs.kind is replaced by one that
-- lists EVERY job kind: the 0022 kinds, 'mix_relay' (iPhone relay mode, below) and 0027's
-- 'wrapped_build'. So it is safe in either order:
--   * after 0027 (production: 0027 was applied first) — 'wrapped_build' stays allowed, and
--     existing wrapped_build rows stay valid (the earlier version listed only four kinds and
--     would have failed on them, or silently broken "Build Wrapped");
--   * before 0027 (a fresh database, number order) — 0027 then sets the same five kinds.
-- Nothing is dropped or renamed. Everything else here is new tables.
--
-- Policy: a mixed Spotify + YouTube/SoundCloud queue conflicts with Spotify's Developer Policy
-- III.5 / III.7 (01-feasibility.md §6.1). Rotor keeps it off unless you opt in per device in
-- Settings › Experimental, never overlaps or crossfades audio, and never renders YouTube or
-- SoundCloud items inside a Spotify list (Spotify items in a mix are text + source badge only).
--
-- mixes / mix_items: a separate list type that lives in Elsewhere. A Spotify item keeps its URI
--   plus a title/artist snapshot (no Spotify artwork); a YouTube/SoundCloud item points at
--   media_items (0024).
-- playback_sessions: one run of a mix, with the device and mode (laptop = the page conducts;
--   relay = iPhone, a push at the end of each Spotify part).
-- handoff_events: every source change with its outcome and gap, for the session summary.
--
-- RLS on, no policies, on every new table.
--
-- One transaction: a failure leaves nothing half-applied (it goes to production after 0027).

BEGIN;

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '15s';

CREATE TABLE mixes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mix_items (
  mix_id        uuid NOT NULL REFERENCES mixes (id) ON DELETE CASCADE,
  position      int  NOT NULL,
  source        text NOT NULL CHECK (source IN ('spotify', 'youtube', 'soundcloud')),
  spotify_uri   text,                          -- spotify:track:…
  media_item_id uuid REFERENCES media_items (id) ON DELETE CASCADE,
  title         text NOT NULL,                 -- snapshot for display (verbatim)
  artist        text,
  duration_ms   int,
  PRIMARY KEY (mix_id, position),
  CHECK ((source = 'spotify' AND spotify_uri IS NOT NULL AND media_item_id IS NULL)
      OR (source <> 'spotify' AND media_item_id IS NOT NULL AND spotify_uri IS NULL))
);

CREATE TABLE playback_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id            uuid NOT NULL REFERENCES mixes (id) ON DELETE CASCADE,
  mode              text NOT NULL CHECK (mode IN ('laptop', 'relay')),
  device_label      text,
  spotify_device_id text,
  position          int NOT NULL DEFAULT 0,      -- mix position the conductor is at (relay reads it)
  progress_at       timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  final_state       jsonb
);
CREATE INDEX idx_playback_sessions_mix ON playback_sessions (mix_id, started_at DESC);

CREATE TABLE handoff_events (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES playback_sessions (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  from_source text,
  to_source   text,
  position    int,
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'autoplay_blocked', 'not_embeddable', 'diverged', 'spotify_autoplay', 'timeout', 'relay', 'preview_skipped')),
  gap_ms      int,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_handoff_events_session ON handoff_events (session_id, at);

-- Relay mode: a hub job waits for the end of a Spotify part and sends the push.
-- Same list as 0027 (keep them identical): applying 0025 after 0027 must not narrow it.
ALTER TABLE hub_jobs DROP CONSTRAINT IF EXISTS hub_jobs_kind_check,
  ADD CONSTRAINT hub_jobs_kind_check
  CHECK (kind IN ('reseed_daily_pick', 'refresh_managed', 'push_test', 'mix_relay', 'wrapped_build'));

ALTER TABLE mixes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE mix_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE playback_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoff_events    ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (25, 'mixes');

COMMIT;
