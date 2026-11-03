# 04 — Technical architecture

> Recommendation first, then the reasoning. Migrations are **proposals** (filenames + sketches). You apply them yourself in the Supabase SQL editor, in order. Numbering starts at **0019** because 0017 is missing on `main` and 0018 is the latest (`01-feasibility.md` I3).

## 1. Recommendation in one table

| Layer | Choice | Why (short) |
|---|---|---|
| Frontend | **SvelteKit 2 + Svelte 5**, one responsive codebase, installable **PWA** | Small bundles on the phone. Runes make a reactive now-playing store trivial. Built-in transitions for sheets. Already the stated direction (`lib/playlists.py` C1-01 comment). |
| Hosting | **Vercel** (Hobby, personal use), functions pinned to **`fra1`** | Same metro as Supabase `eu-central-1`. SvelteKit adapter is first-class. Preview deploys per branch. |
| Server code | SvelteKit server routes (`+server.ts`, Node runtime) | Spotify OAuth, token refresh, player proxy, guarded playlist writes. No second runtime. |
| Database | Existing **Supabase Postgres**, server-side connection only | RLS stays deny-all. No anon key in the browser. |
| Batch logic | Existing **Python + GitHub Actions** | Daily-pick generation, managed playlists, snapshots stay in Python. The hub *requests* work through a job table + `workflow_dispatch`. |
| Laptop | Same PWA installed from Chrome/Edge; **Web Playback SDK** = "This laptop" device | No shell needed. Optional Tauri menu-bar companion later (`01-feasibility.md` §8). |
| iPhone | Same PWA from the Home Screen, **remote only** | The Spotify app stays the speaker (`01-feasibility.md` §2, §7). |

## 2. Re-validating SvelteKit + Vercel against the new requirements

The earlier direction predates remote control and the laptop requirement, so each alternative was checked against them:

| Requirement | SvelteKit PWA (Vercel) | Next.js PWA | Expo / React Native | Flutter | Keep Streamlit |
|---|---|---|---|---|---|
| Remote control (server-held token, low-latency commands) | 🟢 server routes | 🟢 route handlers | 🟢 (needs its own backend anyway) | 🟢 (same) | 🔴 every click is a full rerun, so no live player |
| Live now-playing UI (polling, interpolation, optimistic) | 🟢 runes store | 🟢 | 🟢 | 🟢 | 🔴 |
| Laptop as speaker (Web Playback SDK) | 🟢 browser | 🟢 browser | 🔴 SDK is web-only; react-native-web would be a browser app anyway | 🔴 | 🔴 |
| iPhone lock-screen / background | remote only (fine) | same | 🟢 native audio, but Spotify's playback is in the Spotify app anyway | same as RN | — |
| Install on iPhone without App Store | 🟢 Home Screen | 🟢 | 🔴 needs a $99/yr Apple developer account, or free provisioning that expires every 7 days | 🔴 same | 🟢 (bookmark) |
| One codebase phone + laptop | 🟢 | 🟢 | 🟡 | 🟡 | 🟢 |
| Bundle / perf on phone | 🟢 smallest | 🟡 heavier runtime | 🟢 | 🟢 | 🔴 |
| Build effort with Claude Code | 🟢 | 🟢 | 🟡 native toolchains | 🟡 | — |

**Verdict:** SvelteKit PWA on Vercel still wins. The new requirements strengthen the web choice: the Web Playback SDK only exists on the web. Next.js would work equally well technically. It's the runner-up, not a mistake.

Hosting alternatives considered: Cloudflare Pages/Workers (fine, but the `postgres` driver over TCP needs Hyperdrive, one more moving part) and Supabase Edge Functions (Deno, a third runtime next to Python and Node). Neither beats a single Vercel project.

### 2.1 Repo layout

```
music-tracker/
├─ hub/                       ← new SvelteKit app (Vercel "Root Directory" = hub/)
│  ├─ src/lib/server/         ← spotify/ (oauth, token, player, write-guard), db/, jobs/
│  ├─ src/lib/stores/         ← player.svelte.ts (now-playing store), toasts, sheets
│  ├─ src/lib/components/     ← design-system components (05-design.md)
│  ├─ src/routes/             ← (app)/home, search, library, stats, playlist/[id], track/[uri] …
│  │                            api/ auth/, player/, home/, playlists/, jobs/, push/
│  ├─ static/manifest.webmanifest, icons/
│  └─ src/service-worker.ts   ← app shell + last-home-payload cache
├─ lib/, scripts/, views/, app.py   ← Python stays exactly where it is
└─ migrations/0019…           ← SQL, applied by hand
```

Python and TypeScript share **the database**, not code. Types for TypeScript come from the schema (`kysely-codegen` or `supabase gen types` against the DB).

## 3. Spotify calls, tokens, auth and Supabase RLS

### 3.1 Where Spotify calls run

| Call type | Runs in | Reason |
|---|---|---|
| OAuth code exchange, token refresh | **server** | Needs the client secret. The repo is public. |
| Player state + commands (`/me/player/*`) | **server proxy** `/api/player/*` | Keeps the browser token-free on phones. Adds ~20–60 ms (browser → `fra1` → Spotify EU), which is noise next to Connect's 0.3–1.5 s. The proxy also *enriches* state with your stats (§6.3). |
| Web Playback SDK (`getOAuthToken`) | **browser** (laptop only) | The SDK requires a client-side access token. It gets a 1-hour access token from `GET /api/spotify/token`, never the refresh token. |
| Playlist writes (daily-pick playlist, custom playlists) | **server**, one module `write-guard.ts` | Enforces hard rule 3 (§3.4). |
| Library mirror reads (`/me/playlists`, `/playlists/{id}/items`) | Python nightly + server on demand | Keeps request paths free of pagination. |

### 3.2 Single-user login

- **Login = Spotify OAuth** (Authorization Code, server-side with client secret; `state` + PKCE verifier against CSRF and code interception).
- After the code exchange the server calls `GET /me` and **accepts only `id == OWNER_SPOTIFY_ID`** (env). Development Mode's allowlist (5 users) is a second gate.
- Session: random 256-bit ID in an `HttpOnly; Secure; SameSite=Lax` cookie (30 days, sliding). Only its SHA-256 is stored (`hub_sessions`), so a DB leak doesn't yield sessions. "Sign out everywhere" deletes the rows.
- Mutating routes require the session plus an `Origin` header check. CSP: `default-src 'self'`; scripts from self + `sdk.scdn.co` (Web Playback SDK) + `www.youtube.com` + `w.soundcloud.com`; `connect-src` self + `api.spotify.com`.

### 3.3 Token storage and refresh (and the 6-month clock)

```sql
-- 0019_hub_auth.sql (sketch)
CREATE TABLE hub_oauth_tokens (
  client            text PRIMARY KEY,          -- 'hub' | 'cron'
  provider          text NOT NULL DEFAULT 'spotify',
  account_id        text NOT NULL,             -- Spotify user id
  refresh_token_enc bytea NOT NULL,            -- AES-256-GCM, key = TOKEN_ENC_KEY (Vercel + GitHub secret)
  access_token_enc  bytea,                     -- cached, avoids refresh storms across lambdas
  access_expires_at timestamptz,
  scopes            text NOT NULL,
  authorized_at     timestamptz NOT NULL,      -- Spotify: lifetime = 6 months from HERE
  last_refresh_at   timestamptz,
  last_error        text
);
CREATE TABLE hub_sessions (
  id_hash      bytea PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);
ALTER TABLE hub_oauth_tokens ENABLE ROW LEVEL SECURITY;  -- deny-all, server uses owner role
ALTER TABLE hub_sessions     ENABLE ROW LEVEL SECURITY;
INSERT INTO migrations_applied (number, name) VALUES (19, 'hub_auth');
```

Refresh logic (server): take the cached access token if it has > 2 min left; otherwise refresh under a row lock (`SELECT … FOR UPDATE SKIP LOCKED`) so parallel lambdas don't stampede. If Spotify returns a new `refresh_token`, store it, but **don't** move `authorized_at` (refreshing doesn't extend the lifetime). On `invalid_grant`: write `last_error`, return 401 `reauth_required`, and the UI shows "Reconnect Spotify".

**Countdown:** `authorized_at + interval '6 months'`. Header dot turns amber at 21 days left, red at 7. Web Push at 14 and 3 days.

**The cron token.** Two options (open question 4):
- **A (recommended):** the hub can also authorize the `cron` client (same Client ID, the cron's scope set, the hub's redirect URI). `lib/spotify.py` gets a ~15-line change in Release 1: read `hub_oauth_tokens` where `client = 'cron'` (decrypt with `TOKEN_ENC_KEY` from GitHub secrets), fall back to `SPOTIFY_REFRESH_TOKEN`. Then one "Reconnect" tap fixes the crons too. No more `spotify_auth.py` + copy-paste into GitHub secrets every 6 months.
- **B:** crons keep their GitHub secret. The hub only stores the date you enter and reminds you.

**Same Client ID for hub and crons.** A new Client ID would fall under the restricted Feb 2026 endpoint set immediately and gains nothing on quota, which is shared per account (`01-feasibility.md` §0.1). Add the redirect URI `https://<rotor>.vercel.app/auth/callback` to the existing app.

### 3.4 The read-only rule, enforced in code

All Spotify writes go through `hub/src/lib/server/spotify/write-guard.ts`, the TypeScript twin of the SAFETY CONTRACT comment in `lib/playlists.py`:

```ts
const MANAGED = [' · Auto 🤖🔄', ' · Auto 🤖📸', ' · Custom 🎧'] as const;

export async function assertWritable(playlistId: string): Promise<void> {
  const p = await spotifyGet(`/playlists/${playlistId}?fields=name,owner(id)`); // live, not cached
  if (p.owner.id !== env.OWNER_SPOTIFY_ID) throw new ReadOnlyPlaylist(playlistId, 'not owned');
  if (!MANAGED.some((s) => p.name.endsWith(s))) throw new ReadOnlyPlaylist(playlistId, 'no managed suffix');
}
// The only exported writers; each calls assertWritable first:
// replaceItems(), addItems(), removeItems(), changeDetails(), unfollowCustom()   // unfollowCustom also requires ' · Custom 🎧'
```

- The **only** non-guarded write is `POST /me/playlists` (create), and the created name always ends with a suffix.
- Unit tests cover suffix spoofing (e.g. `"x · Custom 🎧 (copy)"` must fail) and non-owned playlists.
- The UI hides edit affordances, but the guard, not the UI, is the safety net.

### 3.5 Supabase connection and RLS

- Verified on 2026-11-03: **all 14 public tables have RLS enabled with zero policies** (`pg_policies` is empty), so PostgREST/anon access is deny-all. Keep it that way.
- The hub server connects like Streamlit and the crons do: a `DATABASE_URL` for the Supavisor **transaction pooler** (port 6543, `prepare: false` for serverless), as the table-owning role, which bypasses RLS. Same trust level as today, now behind real auth.
- **No `supabase-js` and no anon key in the browser.** The browser talks only to Rotor's own API.
- Every new table: `ENABLE ROW LEVEL SECURITY` in its own migration, no policies.
- Materialized views can't carry RLS and Supabase's advisor flags them in exposed schemas. Put them in a new schema **`hub`** that is *not* in PostgREST's exposed schemas.
- Hardening option (later): a dedicated `rotor_app` role with explicit grants + `USING (true)` policies scoped `TO rotor_app`, instead of the owner role.

### 3.6 Secrets (Vercel env, never in the repo)

`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `OWNER_SPOTIFY_ID`, `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENC_KEY`, `YOUTUBE_API_KEY` (R4), `GITHUB_DISPATCH_TOKEN` (fine-grained PAT: *this repo only*, `actions: write`), `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`. Add `hub/.env.example` with placeholders only.

## 4. Generation logic: Python stays the engine

**Rule:** anything batch-shaped (ranking, recipes, ~200 playlists, snapshots) stays in Python. TypeScript does only interactive glue that must answer in < 1 s.

| Feature | Logic lives in | How the hub triggers it | Duplication? |
|---|---|---|---|
| Daily-pick candidates | **Python** `scripts/generate_daily_picks.py` (new, R1) — cron `30 4 * * *` (after popularity scores, before snapshots) | Reads `daily_pick_candidates` | None |
| Rotate | — (choose next precomputed candidate) | `UPDATE daily_pick_state` | None |
| "Shuffle the deck" (new candidates now) | Python, same script with `--date today --reseed` | `INSERT hub_jobs` → `workflow_dispatch` of a new `hub-jobs.yml` (input `job_id`) → Python writes results → hub polls the job / gets a push. ~45–90 s, acceptable for a rare action | None |
| Play a generated pick | TypeScript: replace items of `Daily pick · Auto 🤖🔄` (guarded) + `PUT /me/player/play` | `/api/daily/play` | ~30 lines of Spotify glue (accepted: it's just API calls) |
| Custom playlist **preview** | **SQL function** `hub.custom_playlist_preview(filters jsonb)` (port of `query_temp_playlist_tracks`' SQL, R2) | `SELECT` from TS | One copy of the SQL. Python's `query_temp_playlist_tracks` can call the same function in R2, so the duplication disappears instead of growing |
| Custom playlist **create / update / delete** | TypeScript (guarded writes) + `custom_playlists` row | `/api/custom/*` | ~60 lines of glue, accepted: a 1-minute GitHub Action behind a "Create" button would be bad UX. The *selection* logic is shared (SQL function); only the API calls are duplicated |
| TTL sweep | Python (existing cron) | — | None |
| Order preference, force refresh | Python crons read `playlist_settings` (existing intent pattern) | `UPDATE playlist_settings` | None |
| Refresh one managed playlist now | Python, new `--only <playlist_id>` flag on `update_managed_playlists.py` | `hub_jobs` + `workflow_dispatch` | None |

**Why a new `hub-jobs.yml`, not `scheduled-ingest.yml`:** every job in `scheduled-ingest.yml` runs on `workflow_dispatch`, so dispatching it would run the whole nightly + weekly + monthly set (`02-inventory.md` §E). `hub-jobs.yml` takes `job_id`, loads the row, dispatches to one Python entry point and writes `status/result` back.

**Rejected alternatives:**
- *Vercel Python functions importing `lib/`*: possible, but pandas/psycopg cold starts, an unverified mixed-runtime setup with the SvelteKit adapter, and `lib/` is written for batch (prints, long loops).
- *Rewriting recipes in TypeScript*: two engines drifting apart, which is exactly what C1-01's `rule_nl` warns about.

### 4.1 Daily-pick generator sketch (Python, R1)

```
for date D (Europe/Amsterdam):
  generated = [recipe(conn, D) for recipe in RECIPES_ENABLED]          # 3 picked by weekday rotation
     RECIPES: forgotten_gems   (liked, ≥20 plays, not heard ≥180 d)
              evergreen_core   (evergreen_pct ≥ 0.8, not heard ≥ 21 d)
              fresh_heat       (top plays last 14 d ∪ missed-new unplayed)
              artist_deep_dive (one artist from top-50, tracks you played < 3×)
              discovered_in_Y  (Year Discovered Y, random Y ≠ last 7 days' Y)
  existing  = top 2 of rank(rotation_score) over spotify_playlists
              where is_owned or is_followed, not managed-auto (avoid Top 100 every day),
              not suggested in last 30 d
  write 5 candidates (rank 1..5, interleaved generated/existing) → daily_pick_candidates
```

`rotation_score` = `0.5·norm(days_since_suggested) + 0.3·(1 − coverage_60d) + 0.2·affinity`, with `coverage_60d` only for owned playlists (items readable) and `affinity` = mean `composite_score` of known tracks (`01-feasibility.md` §3.3).

## 5. Data model additions (proposed migrations)

| File | Release | Contents |
|---|---|---|
| `0019_hub_auth.sql` | R1 | `hub_oauth_tokens`, `hub_sessions` (§3.3) |
| `0020_spotify_playlist_mirror.sql` | R1 | `spotify_playlists`, `spotify_playlist_items` |
| `0021_daily_picks.sql` | R1 | `daily_pick_candidates`, `daily_pick_state`, `playlist_rotation_history` |
| `0022_hub_jobs_and_push.sql` | R2 | `hub_jobs`, `push_subscriptions`; `custom_playlists` + `filters_json`, `excluded_uris` |
| `0023_hub_stats_rollups.sql` | R3 | schema `hub`, MVs + `hub.refresh_rollups()`, `hub.home_payload()` |
| `0024_media_sources.sql` | R4 | `media_items`, `collections`, `collection_items` |
| `0025_mixes.sql` | R5 (optional) | `mixes`, `mix_items`, `playback_sessions`, `handoff_events` |

Sketches (columns that matter; every table gets `ENABLE ROW LEVEL SECURITY` and a `migrations_applied` row):

```sql
-- 0020_spotify_playlist_mirror.sql
CREATE TABLE spotify_playlists (
  playlist_id   text PRIMARY KEY,
  name          text NOT NULL,                 -- verbatim from Spotify
  owner_id      text NOT NULL,
  is_owned      boolean NOT NULL,
  is_collab     boolean NOT NULL DEFAULT false,
  managed_kind  text CHECK (managed_kind IN ('auto_updating','auto_snapshot','custom')), -- NULL = read+play only
  snapshot_id   text,
  track_count   int,
  image_url     text,
  last_seen_at  timestamptz NOT NULL,          -- disappears from /me/playlists → soft-delete
  removed_at    timestamptz
);
CREATE TABLE spotify_playlist_items (           -- only for is_owned OR is_collab (API restriction)
  playlist_id text REFERENCES spotify_playlists ON DELETE CASCADE,
  position int, track_uri text, added_at timestamptz,
  snapshot_id text,
  PRIMARY KEY (playlist_id, position)
);

-- 0021_daily_picks.sql
CREATE TABLE daily_pick_candidates (
  pick_date   date NOT NULL,                   -- Europe/Amsterdam calendar day
  rank        smallint NOT NULL,               -- 1..5 (later reseeds append 6..10)
  kind        text NOT NULL CHECK (kind IN ('generated','existing_playlist')),
  recipe      text,                            -- e.g. 'forgotten_gems'
  playlist_id text REFERENCES spotify_playlists, -- for existing_playlist
  title       text NOT NULL,
  reason      text NOT NULL,                   -- "Not played in 214 days"
  track_uris  text[],                          -- for generated (≤ 100)
  score       numeric(6,4),
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pick_date, rank)
);
CREATE TABLE daily_pick_state (
  pick_date    date PRIMARY KEY,
  current_rank smallint NOT NULL DEFAULT 1,
  played_rank  smallint,
  played_at    timestamptz,
  rotated      smallint[] NOT NULL DEFAULT '{}'
);
CREATE TABLE playlist_rotation_history (
  playlist_id       text PRIMARY KEY REFERENCES spotify_playlists,
  last_suggested_on date,
  last_played_on    date,                      -- when played via Rotor
  times_suggested   int NOT NULL DEFAULT 0,
  times_played      int NOT NULL DEFAULT 0
);

-- 0022_hub_jobs_and_push.sql
CREATE TABLE hub_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,          -- 'reseed_daily_pick' | 'refresh_managed' | 'import_collection' …
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, finished_at timestamptz,
  result jsonb, error text
);
CREATE TABLE push_subscriptions (endpoint text PRIMARY KEY, p256dh text, auth text,
  device_label text, created_at timestamptz DEFAULT now());
ALTER TABLE custom_playlists ADD COLUMN filters_json jsonb, ADD COLUMN excluded_uris text[];

-- 0024_media_sources.sql  (multi-source)
CREATE TABLE media_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('spotify','youtube','soundcloud')),
  source_id text NOT NULL,                     -- track uri / video id / soundcloud url
  title text NOT NULL, artist_display text,
  duration_ms int, artwork_url text,
  isrc text,                                   -- when known: joins to track_metadata
  embeddable boolean, is_preview_only boolean, -- YouTube embeddable / SoundCloud Go+ 30 s
  last_checked_at timestamptz NOT NULL,        -- YouTube III.E.4: refresh or delete after 30 d
  raw jsonb,
  UNIQUE (source, source_id)
);
CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('youtube','soundcloud')),  -- Spotify stays in spotify_playlists
  source_collection_id text NOT NULL,          -- YouTube playlist id / SoundCloud set url
  kind text NOT NULL CHECK (kind IN ('playlist','set','likes_set','manual')),
  title text NOT NULL, artwork_url text, item_count int,
  imported_at timestamptz NOT NULL DEFAULT now(), last_synced_at timestamptz,
  UNIQUE (source, source_collection_id)
);
CREATE TABLE collection_items (
  collection_id uuid REFERENCES collections ON DELETE CASCADE,
  position int, media_item_id uuid REFERENCES media_items,
  PRIMARY KEY (collection_id, position)
);

-- 0025_mixes.sql  (only if mixed sessions are built, R5)
CREATE TABLE mixes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE mix_items (mix_id uuid REFERENCES mixes ON DELETE CASCADE, position int,
  media_item_id uuid REFERENCES media_items, PRIMARY KEY (mix_id, position));
CREATE TABLE playback_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id uuid REFERENCES mixes, device_label text, spotify_device_id text,
  started_at timestamptz DEFAULT now(), ended_at timestamptz, final_state jsonb);
CREATE TABLE handoff_events (id bigserial PRIMARY KEY, session_id uuid REFERENCES playback_sessions,
  at timestamptz DEFAULT now(), from_source text, to_source text,
  outcome text CHECK (outcome IN ('ok','autoplay_blocked','not_embeddable','diverged','spotify_autoplay','timeout')),
  gap_ms int, detail jsonb);
```

Why YouTube/SoundCloud don't go into `spotify_plays`: the stats are Spotify-history stats, and Spotify policy III.5 argues for keeping the stores apart. If you later want "Elsewhere" listening counted, add `elsewhere_plays (media_item_id, played_at, ms_played)` and show it only in Elsewhere.

## 6. Now-playing state, polling, caching, query performance

### 6.1 Client store (`player.svelte.ts`)

```
state: { device, item, context, isPlaying, progressMs, fetchedAt, durationMs, shuffle, repeat, disallows }
derived: position = isPlaying ? progressMs + (now − fetchedAt) : progressMs   (rAF ticker only while visible)
optimistic overlay: pending command {kind, expected} → cleared on confirm or rolled back after 2 mismatches
adapters: ConnectAdapter (polls /api/player/state) | SdkAdapter (Web Playback SDK events, no polling)
command queue: serialised, await 204 before the next ("order of execution is not guaranteed")
leader election: BroadcastChannel('rotor-player'): only one tab/window polls, the others listen
```

Polling cadence is as in `01-feasibility.md` §1.4: 5 s while visible and playing, plus an exact poll at track end. 15 s when paused, 0 when hidden, back-off on 429.

### 6.2 Server player proxy

- `GET /api/player/state` → `GET /me/player` → enrich: context name and kind from `spotify_playlists` (no extra Spotify call), and **your stats for the current track** from `hub.mv_track_stats` (plays, first play, badges count). One round trip feeds the mini-player *and* the history card.
- `POST /api/player/{play|pause|next|previous|seek|volume|shuffle|repeat|transfer|queue}` → validates, forwards with explicit `device_id`, returns Spotify's status code. Play with a pending intent (`03-ux-ia.md` §8) is handled client-side.
- No server-side caching of player state (it's live). Per-track stats cached in memory for 10 min.

### 6.3 Caching

| What | Where | TTL / invalidation |
|---|---|---|
| App shell, fonts, icons | Service worker | versioned on deploy |
| Last `/api/home` payload | Service worker (stale-while-revalidate) | Opens instantly offline or cold. Revalidates on open |
| Home / stats payloads | `Cache-Control: private, max-age=30` + ETag = rollup refresh timestamp | Changes only when MVs refresh (every ingest) |
| Playlist mirror | DB (`spotify_playlists`) | Nightly Python sync + on-demand refresh when Library opens and data is > 1 h old (`GET /me/playlists`, ~6 pages) |
| Access token | DB (encrypted) + lambda memory | expiry − 2 min |

### 6.4 Query performance: measured, and the fix

Measured 2026-11-03 (production, read-only, `EXPLAIN ANALYZE`):

| Query (from today's dashboard) | Time | Plan problem |
|---|---|---|
| Totals: `COUNT(*)`, `COUNT(DISTINCT track)`, `COUNT(DISTINCT artist)` on `unified_plays` | **8.9 s cold / 1.1 s warm** | seq scan + external merge sort (16 MB on disk) |
| Current streak (distinct local dates + window) | **3.6 s** | sort 420k rows to get 3,493 days |
| On this day (`EXTRACT(month/day)` filter) | **4.0 s** | expression filter, seq scan |
| Per-track all-time `GROUP BY track_uri` (+min/max) | **0.63 s** | parallel index-only scan; fine for a nightly job, too slow per request |
| Per-day rollup (`GROUP BY local date`) | **0.29 s** | the whole history is 3,493 rows |
| Top tracks last 30 days | **6 ms** | index range on `played_at` |
| One track's lifetime stats | **23 ms** | index on `track_uri` |

**Fix (0023_hub_stats_rollups.sql):** a few small materialized views in schema `hub`, refreshed after every ingest, plus one RPC that returns the whole Home payload.

```sql
CREATE SCHEMA hub;
CREATE MATERIALIZED VIEW hub.mv_daily_listening AS            -- ~3.5k rows
  SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date AS d,
         count(*) AS plays, sum(ms_played) AS ms, count(DISTINCT track_uri) AS tracks
  FROM spotify_plays WHERE track_uri IS NOT NULL GROUP BY 1;
CREATE UNIQUE INDEX ON hub.mv_daily_listening (d);

CREATE MATERIALIZED VIEW hub.mv_track_stats AS                 -- ~30k rows
  SELECT track_uri, count(*) AS plays, min(played_at) AS first_played_at, max(played_at) AS last_played_at,
         count(*) FILTER (WHERE played_at >= now() - interval '30 days')  AS plays_30d,
         count(*) FILTER (WHERE played_at >= now() - interval '365 days') AS plays_365d,
         avg(skipped::int) AS skip_rate
  FROM spotify_plays WHERE track_uri IS NOT NULL GROUP BY 1;
CREATE UNIQUE INDEX ON hub.mv_track_stats (track_uri);

CREATE MATERIALIZED VIEW hub.mv_track_day AS                   -- per (local day, track): on-this-day, heatmaps by day
  SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date AS d, track_uri,
         max(track_name) AS track_name, max(artist_name) AS artist_name, count(*) AS plays
  FROM spotify_plays WHERE track_uri IS NOT NULL GROUP BY 1, 2;
CREATE UNIQUE INDEX ON hub.mv_track_day (d, track_uri);
CREATE INDEX ON hub.mv_track_day ((extract(month FROM d) * 100 + extract(day FROM d)));

CREATE MATERIALIZED VIEW hub.mv_artist_stats AS …;            -- via track_metadata.artist_ids (multi-artist aware)
CREATE MATERIALIZED VIEW hub.mv_hour_dow AS …;                -- 168 rows

CREATE FUNCTION hub.refresh_rollups() RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY hub.mv_daily_listening;
  REFRESH MATERIALIZED VIEW CONCURRENTLY hub.mv_track_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY hub.mv_track_day;
  REFRESH MATERIALIZED VIEW CONCURRENTLY hub.mv_artist_stats;
  REFRESH MATERIALIZED VIEW CONCURRENTLY hub.mv_hour_dow;
$$;
CREATE FUNCTION hub.home_payload(p_today date) RETURNS jsonb …;  -- tiles + shelves in one call, target < 50 ms
```

- Refresh cost estimate: ~2–3 s total (each MV is one pass similar to the 0.29–0.63 s measurements, plus `CONCURRENTLY` overhead). The */30 ingest calls `SELECT hub.refresh_rollups()` at its end: one line in `scripts/ingest_spotify_recent.py`, added in R3.
- Streaks and biggest day then come from 3.5k rows (sub-ms). On-this-day uses the `month*100+day` index. Totals use `sum(plays)` over the daily view plus `count(*)` over `mv_track_stats`.
- Stats screens that need arbitrary ranges (Top with custom range) keep querying `spotify_plays` directly. Those use the `played_at` index and are ⚡ for short ranges, ◐ for all-time, which is acceptable behind a skeleton.

## 7. Coexistence with Streamlit during migration

| Phase | Streamlit (`app.py`) | Rotor (`hub/`) | Who owns writes |
|---|---|---|---|
| R1 | unchanged | remote control, Home with daily pick, Settings › Connections | Rotor: `Daily pick` playlist, tokens. Streamlit: everything else |
| R2 | Playlist Modification + Rules still work; README points to Rotor | custom playlists, managed settings, rules | **Rotor** for new custom playlists. Both can still delete/extend (same table, idempotent updates) |
| R3 | read-only banner: "Moved to Rotor" (one-line `st.info` per page); write buttons removed | stats parity | Rotor |
| R4–R5 | frozen, still reachable as a fallback | Elsewhere (YT/SC), optional mixed sessions | Rotor |
| R6 (v1.0) | **retired**: delete Streamlit Cloud app, remove `app.py`, `views/`, `streamlit`/`altair` deps, `.streamlit/` | — | Rotor |

- Same DB, same tables; no data migration needed. Both read `custom_playlists` and `playlist_settings`. Writes are single-row and idempotent, so concurrent use is harmless.
- Streamlit's secrets (`DATABASE_URL`, `SPOTIFY_*`) keep working until retirement. If option A (§3.3) lands, Streamlit's own Spotify writes (create/delete custom) still use the env token. That's fine until R3, when those buttons go away.
- `lib/` Python modules that Streamlit imports (`temporary_playlists`, `playlist_settings`, `playlists`) are also used by crons, so they stay. Only `views/` and `app.py` go.

## 8. Cost and limits

- Vercel Hobby (personal, non-commercial: matches Spotify IV.2 anyway). One user's player polling ≈ 1.5k function invocations per listening hour. Small next to Hobby allowances.
- Supabase free tier: public tables total ≈ 255 MB today (`spotify_plays` alone is 163 MB, measured 2026-11-03), and the free tier caps the database at 500 MB. Rollups add < 30 MB (`mv_track_day` is the largest, estimated 200–250k rows). Watch this. The cap is closer than the size suggests. The */30 cron keeps the project from pausing.
- GitHub Actions: `hub-jobs.yml` runs only on demand. The keepalive problem (`01-feasibility.md` I1) must be fixed regardless, or *all* crons stop around 2026-11-28.
