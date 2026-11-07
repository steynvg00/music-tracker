-- 0033: drop_scrobbles_AFTER_ARCHIVE — DESTRUCTIVE. Apply ONLY by hand, and ONLY after
-- scripts/archive_scrobbles.py has written AND verified the archive (row count + checksums).
--
-- What it does: drops the last.fm-era `scrobbles` table (~38 MB in production: heap + its PK, the
-- UNIQUE (source, played_at, track_id) index and two more indexes). Nothing else is touched: the
-- last.fm `tracks` / `artists` / `albums` tables stay (scripts/ingest_scrobbles.py still writes them).
--
-- Who still reads scrobbles (checked for v0.90 on main + this branch):
--   * unified_plays view: NO. Since 0004 it reads spotify_plays only, so no view change is needed.
--     The DROP below has no CASCADE: if anything did depend on scrobbles it would fail, not cascade.
--   * crons (.github/workflows/*.yml, lib/, scripts/ run by them): NO. Only the manual
--     scripts/ingest_scrobbles.py touches it; it now stops with a message when the table is gone.
--   * Rotor: only Settings › Data health's "last.fm (historic import)" line, which since v0.90 is its
--     own soft query (shows "archived" once the table is gone).
--   * Streamlit: removed in v1.0 (#98); it only ever read unified_plays.
--
-- How to apply (Supabase SQL editor), after the archive script printed "VERIFIED":
--   1. Paste the SET line the script printed, e.g.:   SET rotor.scrobbles_archived_rows = '612345';
--   2. Paste this whole file below it and Run.
-- The guard refuses to drop when the setting is missing or its row count differs from the table's
-- (rows added after the archive, or the wrong archive). Re-running after success is a no-op.

BEGIN;

SET LOCAL lock_timeout = '15s';

-- Check and drop in ONE transaction, with the table locked, so no row can slip in between.
DO $$
DECLARE
  expected text := current_setting('rotor.scrobbles_archived_rows', true);
  n bigint;
BEGIN
  IF to_regclass('public.scrobbles') IS NULL THEN
    RAISE NOTICE '0033: scrobbles is already gone, nothing to do';
    RETURN;
  END IF;
  IF expected IS NULL OR expected !~ '^\d+$' THEN
    RAISE EXCEPTION '0033 refused: run scripts/archive_scrobbles.py first and paste the SET rotor.scrobbles_archived_rows line it prints';
  END IF;
  LOCK TABLE scrobbles IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM scrobbles;
  IF n <> expected::bigint THEN
    RAISE EXCEPTION '0033 refused: the archive has % rows but scrobbles has % now; archive again', expected, n;
  END IF;
  -- RESTRICT (the default, no CASCADE): fails if any view or foreign key still depends on scrobbles.
  DROP TABLE scrobbles;
END
$$;

INSERT INTO migrations_applied (number, name) VALUES (33, 'drop_scrobbles_AFTER_ARCHIVE')
ON CONFLICT (number) DO NOTHING;

COMMIT;
