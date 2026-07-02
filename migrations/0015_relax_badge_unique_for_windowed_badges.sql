-- 0015: relax badge_events uniqueness to support windowed (time-period) badges.
--
-- v0.63 constrained badges to one row per (entity_type, entity_id, badge_type).
-- That's right for play milestones (a track earns plays_50 exactly once), but wrong
-- for top_1st_* badges: a track can be the #1 of January 2026 AND February 2026 —
-- both rows have badge_type='top_1st_month' but distinct context->>'window'.
--
-- New uniqueness key includes the JSONB window. NULLS NOT DISTINCT (PG15+) keeps
-- plays_* idempotency intact: those rows have no "window" key, so context->>'window'
-- is NULL for all of them, and NULLS NOT DISTINCT treats two such NULLs as equal —
-- i.e. still one plays_50 per track.

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

ALTER TABLE badge_events
  DROP CONSTRAINT badge_events_entity_type_entity_id_badge_type_key;

CREATE UNIQUE INDEX badge_events_unique_awarded
  ON badge_events (entity_type, entity_id, badge_type, (context->>'window'))
  NULLS NOT DISTINCT;
