-- 0019: hub_auth — Rotor hub sign-in sessions + encrypted Spotify token store (v0.81, R1).
--
-- hub_oauth_tokens holds one row per Spotify authorization Rotor manages:
--   'hub'  — the hub's own Spotify app (player, Web Playback SDK, Daily pick writes)
--   'cron' — the cron app (lib/spotify.py reads this row first and falls back to
--            the SPOTIFY_REFRESH_TOKEN env var; docs/hub-redesign/04-architecture.md §3.3)
-- The two rows can belong to different Spotify apps, so each row records the
-- Client ID that minted it: a refresh only works with that same app's secret.
--
-- Tokens are AES-256-GCM encrypted with TOKEN_ENC_KEY (Vercel env + GitHub secret),
-- format: 0x01 || 12-byte IV || ciphertext || 16-byte tag, AAD 'rotor:<client>:<field>'.
-- A DB dump alone yields no usable token.
--
-- Spotify refresh tokens die 6 months after the authorization that created them and
-- refreshing does not extend that, so authorized_at is set at sign-in/Reconnect and
-- never moved by a refresh.
--
-- hub_sessions stores only a keyed hash (HMAC-SHA256 with SESSION_SECRET) of the
-- session cookie, so a DB leak doesn't yield sessions. "Sign out everywhere" deletes
-- all rows.
--
-- RLS on, no policies: deny-all for PostgREST/anon. The hub, crons and Streamlit
-- connect as the table owner, which bypasses RLS.

SET statement_timeout = 0;
SET lock_timeout = '15s';   -- Lesson #18a safety net: bail rather than block writers

CREATE TABLE hub_oauth_tokens (
  client            text PRIMARY KEY CHECK (client IN ('hub', 'cron')),
  provider          text NOT NULL DEFAULT 'spotify' CHECK (provider = 'spotify'),
  account_id        text NOT NULL,             -- Spotify user id (always OWNER_SPOTIFY_ID)
  spotify_client_id text NOT NULL,             -- the Spotify app that minted this token
  refresh_token_enc bytea NOT NULL,
  access_token_enc  bytea,                     -- cached by the hub, avoids refresh storms across lambdas
  access_expires_at timestamptz,
  scopes            text NOT NULL,             -- space-separated, as granted
  authorized_at     timestamptz NOT NULL,      -- lifetime = 6 months from HERE
  last_refresh_at   timestamptz,               -- for 'cron': the last time a cron used the row
  last_error        text,                      -- e.g. 'invalid_grant'; NULL after a good refresh
  last_error_at     timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE hub_oauth_tokens IS
  'Encrypted Spotify OAuth tokens managed by the Rotor hub (R1). One row per client: hub, cron.';
COMMENT ON COLUMN hub_oauth_tokens.authorized_at IS
  'Original authorization time. Spotify refresh tokens stop working 6 months after this; refreshes never move it.';

CREATE TABLE hub_sessions (
  id_hash      bytea PRIMARY KEY,              -- HMAC-SHA256(SESSION_SECRET, cookie value)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);

CREATE INDEX idx_hub_sessions_last_seen ON hub_sessions (last_seen_at);

ALTER TABLE hub_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_sessions     ENABLE ROW LEVEL SECURITY;

INSERT INTO migrations_applied (number, name) VALUES (19, 'hub_auth');
