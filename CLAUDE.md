# CLAUDE.md

## What this is
A personal music tracker that ingests scrobble history from last.fm and Spotify Extended Streaming History into Postgres, automatically manages structured Spotify playlists (threshold tiers, monthly/seasonal/yearly tops, etc.), and provides Rotor (`hub/`), a SvelteKit PWA with statistics, playback and playlist management. Solo use. Streamlit was retired in v1.0; Rotor is the only frontend. Notifications are Web Push only (no mail since v0.89). Since v0.94 Rotor also keeps your own tracks (unreleased songs / IDs) and DJ / live sets, with uploads in object storage (never in the database).

Full feature spec: `docs/feature-spec.md`.

## Development commands
```bash
uv sync                              # install/sync dependencies
uv run python scripts/<script>.py    # run a one-off script
uv add <pkg>                         # add a runtime dependency
uv add --dev <pkg>                   # add a dev-only dependency
uv run pytest -q                     # Python unit tests (DB + Spotify mocked)
cd hub && npm ci && npm run dev      # Rotor hub (SvelteKit), needs hub/.env
cd hub && npm run check && npm test && npm run build   # hub typecheck, tests, build
```

## Stack
- Python 3.11+ (managed by uv)
- Postgres on Supabase (free tier)
- Rotor hub (the only frontend): SvelteKit 2 + Svelte 5 PWA in `hub/`, Vercel (`fra1`), its own Spotify Client ID
- Web Push (`lib/web_push.py`, `lib/notify.py`) for every notification; no mail
- Object storage for uploads (v0.94): one S3-compatible interface, a PRIVATE Supabase Storage bucket by default, switchable to MinIO / R2 / own server via `MEDIA_S3_*` env vars only
- GitHub Actions cron for scheduled jobs
- APIs: last.fm, Spotify Web API
- GitHub for source control (public repo)

## Conventions
- Branches: `feature/<name>`, `bug/<name>`, `docs/<date>-<topic>`
- Main is protected — PR + squash-merge only, no direct pushes, no force pushes
- Max 2 unmerged feature branches at a time
- Migrations: sequential SQL files in `migrations/` (`0001_*.sql`, `0002_*.sql`, ...), run manually in the Supabase SQL Editor
- Tag after every merge: `git tag v0.X-feature-name && git push --tags`
- Secrets: `.env` locally (gitignored), GitHub Actions secrets for the cron
- Audio and cover files NEVER go into the database (500 MB free tier): only object keys and sizes (`media_objects`, 0036)
- Own plays (`own_plays`, source 'rotor') are never mixed into `spotify_plays` or the Spotify rollups
- Pre-commit hook (`.git/hooks/pre-commit`) is not tracked by git — re-install on any new clone

## Key files
- `scripts/` — scheduled and one-off scripts (CLI only: extended-history import, backfills)
- `lib/` — shared modules (DB, API clients, business logic)
- `migrations/` — Postgres schema migrations
- `docs/feature-spec.md` — full feature specification
- `hub/` — Rotor hub (SvelteKit); `hub/src/lib/server/spotify/write-guard.ts` is the only path for playlist writes
- `lib/hub_jobs.py` + `scripts/run_hub_job.py` + `.github/workflows/hub-jobs.yml` — runner for jobs the hub queues in `hub_jobs` (Shuffle the deck, Refresh now, test push) and the daily hub tasks
- `docs/hub-redesign/` — hub analysis, architecture, design and roadmap (R0–R9, v0.90–v0.92, v0.94)
- `hub/src/lib/server/catalog/` — v0.90 Artist pages (beta) + catalog search: Spotify catalog reads (rate-limit aware), the 0031 cache (TTL, cap, LRU), your-state queries
- `hub/e2e/index_audit.py` — replays every E2E query with EXPLAIN to prove which indexes are needed (0032)
- `scripts/archive_scrobbles.py` — read-only CSV.gz archive of `scrobbles` before the manual migration 0033
- `hub/src/lib/components/PillBar.svelte` + `hub/src/lib/shared/pills.ts` — the one filter bar (Library and Stats)
- `hub/src/lib/swr.svelte.ts` — v0.92 client stale-while-revalidate cache for GET API data (memory + IndexedDB, per build); `hub/src/lib/server/timing.ts` — Server-Timing (db / spotify / total) on every response
- `hub/e2e/tests/perf.spec.ts` + `E2E_SCALE=prod` seed + `hub/scripts/bundle-report.mjs` — speed measurements (v0.92)
- `hub/src/lib/server/organiser.ts` + `hub/src/lib/shared/library.ts` — Rotor-only pins, folders and custom order (0034); never writes to Spotify
- `hub/src/lib/server/storage/` — v0.94 storage interface (`s3.ts`, dependency-free SigV4 in `sigv4.ts`, env config in `config.ts`); `hub/src/lib/server/media.ts` — signed direct uploads (multipart, resume, cancel), playback URLs, usage, guarded delete; `hub/e2e/mock/fake-s3.mjs` — in-process fake S3 for vitest/E2E (never a real bucket in tests)
- `hub/src/lib/server/own.ts` + `hub/src/lib/shared/own.ts` — own tracks (validation incl. placeholder rejection, linked artists, duplicate check, Rotor plays in `own_plays`, Rotor-only lists); `hub/src/lib/server/sets.ts` + `hub/src/lib/shared/sets.ts` — DJ / live sets, tracklist parser + seek; `hub/src/lib/server/prefill.ts` — embed title / MusicBrainz / Spotify catalog suggestions; `hub/src/lib/stores/own-player.svelte.ts` — Rotor's own audio player (Media Session, pauses Spotify first; not a mixed queue)
- `scripts/migrate_media_storage.py` + `lib/media_storage.py` — copy all media objects to a new S3 backend with SHA-256 verification (dry run by default)
- `tests/` — pytest; `tests/fixtures/` is shared with the hub's vitest suite

## Migrations applied
| # | Description | Date |
|---|-------------|------|
| 0001 | initial | 2026-05-19 |
| 0002 | track_spotify_searched | 2026-05-19 |

## Session log
| Date | Branch | Shipped |
|------|--------|---------|
