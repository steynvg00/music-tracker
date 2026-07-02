-- 0014: badge_events — award ledger for the badge system (v0.63)
--
-- Play-milestone badges (plays_50 .. plays_500) land here first; artist badges
-- and other badge types reuse the same table later (entity_type CHECK already
-- allows 'artist', so no future schema migration is needed for that).
--
-- The UNIQUE (entity_type, entity_id, badge_type) constraint is what makes
-- milestone detection idempotent: both the backfill (ON CONFLICT DO NOTHING)
-- and live detection (LEFT JOIN ... IS NULL) rely on it.

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE TABLE badge_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('track', 'artist')),
  entity_id TEXT NOT NULL,
  badge_type TEXT NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context JSONB DEFAULT '{}'::jsonb,
  UNIQUE (entity_type, entity_id, badge_type)
);

CREATE INDEX idx_badge_events_entity ON badge_events (entity_type, entity_id);
CREATE INDEX idx_badge_events_type_time ON badge_events (badge_type, awarded_at DESC);
