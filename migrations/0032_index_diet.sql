-- 0032: index_diet — Rotor v0.90: drop three indexes no query needs.
--
-- Drops only indexes. No table, column or row is touched; any of them can be recreated later with the
-- CREATE INDEX line quoted below (each takes seconds on the production tables).
-- Applies after 0031 (independent of 0025 and 0033).
--
-- Proof (hub/e2e/index_audit.py, run on the E2E database with every hub + Python-job query logged
-- and replayed with enable_seqscan = off and auto_explain incl. the SQL inside hub functions; the
-- report is in the v0.90 PR):
--
--   1. hub.day_track_artist          ON hub.day_track (artist)
--      Prefix-redundant: day_track_artist_d (artist, d) [0027] serves every query on `artist` alone
--      (artist battle, rank race, Wrapped comebacks, discovery). In the replay every statement that
--      used it was served by day_track_artist_d / day_track_artist_track_d instead, none fell back to
--      a sequential scan. Recreate: CREATE INDEX day_track_artist ON hub.day_track (artist);
--
--   2. idx_badge_events_entity       ON badge_events (entity_type, entity_id)
--      Prefix-redundant: badge_events_unique_awarded (entity_type, entity_id, badge_type, (context->>'window'))
--      [0015] starts with the same two columns and is a plain (non-partial) btree.
--      Recreate: CREATE INDEX idx_badge_events_entity ON badge_events (entity_type, entity_id);
--
--   3. idx_track_metadata_artist_names  GIN ON track_metadata (artist_names)
--      Never usable: a GIN index on text[] only serves @>, <@, && and = on the whole array. No query
--      in hub/, lib/ or scripts/ uses those operators on artist_names (they only read it, unnest it or
--      test IS NOT NULL / array_length); artist look-ups go through artist_ids (its own GIN index,
--      kept). No replayed plan picked it, even with sequential scans disabled.
--      Recreate: CREATE INDEX idx_track_metadata_artist_names ON track_metadata USING GIN (artist_names);
--
-- Kept on purpose (looked redundant, isn't): spotify_plays_artist_name_idx (the daily missed-new-tracks
-- cron filters spotify_plays.artist_name = ANY(...)), spotify_plays_played_at_idx (the (played_at, …)
-- unique indexes are partial), day_track_artist_d vs day_track_artist_track_d (different second column).
--
-- Savings: see the v0.90 PR ("Database diet") for the sizes measured on the seeded E2E database and
-- the estimate for production; measure production read-only before applying with:
--   SELECT indexrelid::regclass, pg_size_pretty(pg_relation_size(indexrelid)), idx_scan
--   FROM pg_stat_user_indexes
--   WHERE indexrelid::regclass::text IN ('hub.day_track_artist', 'idx_badge_events_entity', 'idx_track_metadata_artist_names');

BEGIN;

SET LOCAL lock_timeout = '15s';

DROP INDEX IF EXISTS hub.day_track_artist;
DROP INDEX IF EXISTS idx_badge_events_entity;
DROP INDEX IF EXISTS idx_track_metadata_artist_names;

INSERT INTO migrations_applied (number, name) VALUES (32, 'index_diet');

COMMIT;
