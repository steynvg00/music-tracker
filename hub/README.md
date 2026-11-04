# Rotor hub

SvelteKit 2 + Svelte 5 PWA for Vercel (`fra1`, next to Supabase `eu-central-1`).
Spec: `../docs/hub-redesign/` (architecture `04`, design `05`, roadmap `06`).

R1 (`v0.81-hub-remote-and-daily-pick`): Spotify sign-in with an owner gate, encrypted
token store with the 6-month countdown and Reconnect, remote control of any Spotify
Connect device (mini-player, player bar, full-screen player, device picker with the
pending-intent wake flow), "This laptop" via the Web Playback SDK, the daily pick
(Play / Rotate / Shuffle the deck) and Home v1.

## How it fits together

```
browser ──► SvelteKit server routes (Vercel fra1) ──► Spotify Web API (hub's own Client ID)
   │                  │
   │                  └──► Supabase Postgres (transaction pooler, table owner; RLS deny-all)
   └──► Web Playback SDK (laptop only; 1-hour access token from /api/spotify/token)

GitHub Actions (Python, cron app's Client ID): playlist mirror 04:15 UTC,
daily-pick generator 04:30 UTC, "Shuffle the deck" = daily-pick-reseed.yml
```

- The browser never sees a refresh token or the DB. Player commands go through
  `/api/player/*`, which forwards exactly one Spotify call with an explicit `device_id`.
- Tokens are AES-256-GCM encrypted at rest (`src/lib/server/crypto.ts`, byte-compatible
  with `lib/token_store.py`). Sessions store only an HMAC of the cookie.
- **Read-only rule**: every playlist write goes through `src/lib/server/spotify/write-guard.ts`,
  which checks owner + managed suffix live at Spotify first. `SpotifyApi.request()` refuses
  playlist writes; a unit test fails if any other file calls the guard's internal writer.
- Two Spotify apps: the hub's own Client ID (a revoke only hits the hub) and the existing
  cron app. Settings › Connections › "Connect crons" mints the cron token with the cron
  app's credentials (option A); `lib/spotify.py` reads it, falling back to the GitHub secret.
- Restricted Feb 2026 endpoint set only: `/me`, `/me/player/*`, `/me/playlists`,
  `GET /playlists/{id}`, `/playlists/{id}/items`, `PUT /playlists/{id}`, `POST /me/playlists`,
  `/me/library`. Parsers accept both the old (`tracks`, `track`) and new (`items`, `item`) keys.

## Layout

```
src/hooks.server.ts            session + owner gate, Origin check on mutations, security headers
src/lib/server/spotify/        api, oauth, token (store + refresh), player, write-guard, mirror
src/lib/server/                daily (deck, rotate, play), home (payload), wake (pending intent), session, crypto
src/lib/stores/player.svelte.ts  adaptive polling, optimistic commands, BroadcastChannel, SDK adapter
src/lib/player/                polling rules (pure), API client, Web Playback SDK loader
src/lib/components/            design-system components (05-design.md tokens in src/app.css)
src/routes/(app)/              home, daily/[[date]], settings (+ R2/R3 placeholders)
src/routes/api/                player/*, daily/*, home, playlists/sync, spotify/token, connections
src/routes/auth/               login, callback, logout
src/service-worker.ts          app shell + last /api/home (stale-while-revalidate)
```

## Local development

```bash
cp .env.example .env    # fill in; ORIGIN=http://localhost:5173
npm ci
npm run dev             # add http://localhost:5173/auth/callback to BOTH Spotify apps' redirect URIs
npm run check && npm test && npm run build && npm run check:client-secrets
```

Without migrations 0019–0021 applied, every page fails on the session/token tables.
