-- 0030: notification_prefs — Rotor R9: per-type on/off for the Web Push notifications (v0.89).
--
-- Additive only: one new table. Nothing existing is altered, dropped or renamed.
--
-- Every message the crons used to mail is a Web Push now (lib/notify.py). Settings › Notifications
-- writes one row per type the user switches; a type with no row is ON, so applying this migration
-- changes nothing until a switch is flipped. kind = a key of lib/notify.KINDS (checked by the hub's
-- API, not by a CHECK, so a new type needs no migration).
-- Applies after 0029.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE TABLE notification_prefs (
  kind       text        PRIMARY KEY,
  enabled    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (30, 'notification_prefs');

COMMIT;
