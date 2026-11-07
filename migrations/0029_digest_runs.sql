-- 0029: digest_runs — Rotor R8: the weekly/monthly/sweep digest kept as data (v0.88).
--
-- Additive only: one new table. Nothing existing is altered, dropped or renamed.
--
-- lib/email_notify.send_digest writes one row per digest BEFORE it tries to mail (lib/digest_store.py),
-- so Rotor's "This week" page (/digest) shows the Monday mail's content even when delivery fails,
-- and records how it was delivered afterwards. content = the mail's sections before name hydration:
--   { "version": 1,
--     "playlists": [{ "section": "created"|"updated"|"snapshot", "name", "kind", "isTop", "playlistId",
--                     "description", "added": [uri], "removed": [uri], "addedCount",
--                     "ranked": [{ "uri", "rank", "plays", "prev" }], "arrows", "baseline" }],
--     "deleted":   [{ "name", "expiresAt", "trackCount" }],
--     "counts":    { "created", "updated", "snapshots", "deleted" } }
-- Weeks before this migration are reconstructed by the hub from playlist_rank_history (Top lists only).
-- Applies after 0028 (any order relative to 0025).

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE digest_runs (
  id          bigserial   PRIMARY KEY,
  run_type    text        NOT NULL CHECK (run_type IN ('weekly', 'monthly', 'sweep')),
  ran_at      timestamptz NOT NULL DEFAULT now(),
  event_count int         NOT NULL,
  summary     text        NOT NULL,
  content     jsonb       NOT NULL,
  delivery_status text,   -- how it was delivered (mail_sent / mail_failed / …); NULL while sending
  delivery_error  text
);

CREATE INDEX digest_runs_ran_at_idx ON digest_runs (ran_at DESC);

ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (29, 'digest_runs');

COMMIT;
