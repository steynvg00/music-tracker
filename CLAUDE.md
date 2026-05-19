# CLAUDE.md

## What this is
A personal music tracker that ingests scrobble history from last.fm and Spotify Extended Streaming History into Postgres, automatically manages structured Spotify playlists (threshold tiers, monthly/seasonal/yearly tops, etc.), and provides a statistics dashboard. Solo use.

Full feature spec: `docs/feature-spec.md`.

## Development commands
```bash
uv sync                              # install/sync dependencies
uv run streamlit run app.py          # run dashboard locally
uv run python scripts/<script>.py    # run a one-off script
uv add <pkg>                         # add a runtime dependency
uv add --dev <pkg>                   # add a dev-only dependency
```

## Stack
- Python 3.11+ (managed by uv)
- Postgres on Supabase (free tier)
- Streamlit for the dashboard, deployed to Streamlit Community Cloud
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
- Pre-commit hook (`.git/hooks/pre-commit`) is not tracked by git — re-install on any new clone

## Key files
- `app.py` — Streamlit dashboard entry point
- `scripts/` — scheduled and one-off scripts
- `lib/` — shared modules (DB, API clients, business logic)
- `migrations/` — Postgres schema migrations
- `docs/feature-spec.md` — full feature specification

## Migrations applied
| # | Description | Date |
|---|-------------|------|
| 0001 | initial | 2026-05-19 |
| 0002 | track_spotify_searched | 2026-05-19 |

## Session log
| Date | Branch | Shipped |
|------|--------|---------|
