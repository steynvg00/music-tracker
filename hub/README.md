# Rotor hub

SvelteKit 2 + Svelte 5 PWA for Vercel (`fra1`, next to Supabase `eu-central-1`).
Spec: `../docs/hub-redesign/` (architecture `04`, design `05`, roadmap `06`).

R1 (`v0.81-hub-remote-and-daily-pick`): Spotify sign-in with an owner gate, encrypted
token store with the 6-month countdown and Reconnect, remote control of any Spotify
Connect device (mini-player, player bar, full-screen player, device picker with the
pending-intent wake flow), "This laptop" via the Web Playback SDK, the daily pick
(Play / Rotate / Shuffle the deck) and Home v1.

R2 (`v0.82-hub-playlists-and-rules`): Library (all playlists, kind chips, sort, managed
playlists grouped by rule category), playlist detail (About this playlist, sort order,
Refresh now, Rebuild for snapshots, lifetime for custom), the custom playlist builder
(filters with a live count from the shared SQL function `hub.custom_playlist_preview`,
preview, create/edit/extend/keep/delete), the Rules page, the job system (`hub_jobs` +
`hub-jobs.yml`) with queued/running/done/failed in the UI, and Web Push notifications.

## How it fits together

```
browser ──► SvelteKit server routes (Vercel fra1) ──► Spotify Web API (hub's own Client ID)
   │                  │
   │                  └──► Supabase Postgres (transaction pooler, table owner; RLS deny-all)
   └──► Web Playback SDK (laptop only; 1-hour access token from /api/spotify/token)

GitHub Actions (Python, cron app's Client ID): playlist mirror 04:15 UTC,
daily-pick generator 04:30 UTC, hub-jobs.yml daily tasks 05:47 UTC

hub ──INSERT hub_jobs──► Postgres ◄──claim / finish── scripts/run_hub_job.py (hub-jobs.yml)
 └──workflow_dispatch(job_id)──► GitHub Actions ──Web Push (VAPID)──► devices
```

- Jobs: the hub inserts a `hub_jobs` row (one active row per dedupe key) and dispatches
  `hub-jobs.yml` with its id; the runner claims it atomically, so a second dispatch of the
  same id does nothing. The UI polls `/api/jobs/{id}` every 3 s while the tab is visible.
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
- R2 write paths (custom create/edit/delete, all kind-pinned with `requireKind`) also go
  through the guard. The Python refresh path (`lib/managed_refresh.py`) repeats the live
  owner + suffix check before `update_managed_playlist`.
- Restricted Feb 2026 endpoint set only: `/me`, `/me/player/*`, `/me/playlists`,
  `GET /playlists/{id}`, `/playlists/{id}/items`, `PUT /playlists/{id}`, `POST /me/playlists`,
  `/me/library`. Parsers accept both the old (`tracks`, `track`) and new (`items`, `item`) keys.

## Layout

```
src/hooks.server.ts            session + owner gate, Origin check on mutations, security headers
src/lib/server/spotify/        api, oauth, token (store + refresh), player, write-guard, mirror
src/lib/server/                daily (deck, rotate, play), home (payload), wake (pending intent), session, crypto,
                               jobs (enqueue + dispatch), custom (builder), library, push
src/lib/stores/player.svelte.ts  adaptive polling, optimistic commands, BroadcastChannel, SDK adapter
src/lib/player/                polling rules (pure), API client, Web Playback SDK loader
src/lib/components/            design-system components (05-design.md tokens in src/app.css)
src/routes/(app)/              home, daily/[[date]], library, playlist/[id], rules, settings
src/routes/api/                player/*, daily/*, home, playlists/*, custom/*, rules, jobs/*, push/*,
                               spotify/token, connections
src/routes/auth/               login, callback, logout
src/service-worker.ts          app shell + last /api/home (stale-while-revalidate), push + notificationclick
```

## Local development

```bash
cp .env.example .env    # fill in; ORIGIN=http://localhost:5173
npm ci
npm run dev             # add http://localhost:5173/auth/callback to BOTH Spotify apps' redirect URIs
npm run check && npm test && npm run build && npm run check:client-secrets
```

Without migrations 0019–0021 applied, every page fails on the session/token tables.
Without 0022, Library/Rules/custom/jobs answer 500 (the R1 pages keep working).
Web Push needs `VAPID_PUBLIC_KEY` here and `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` as GitHub
secrets (`uv run python scripts/generate_vapid_keys.py`).
