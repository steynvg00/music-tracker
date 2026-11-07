# 07 — Streamlit → Rotor parity (after R8)

> Status of every item in `02-inventory.md` once R1–R4, R6, R7 (merged: #86–#89, #91–#94) and **R8** (`v0.88-hub-parity-gaps`, this update) are in. R5 (mixed sessions) is ignored: it may never ship, and nothing here depends on it. R6 (Wrapped) and R7 (Release radar) add features Streamlit never had, so they don't change any row below. First written 2026-11-06 (after R4); updated 2026-11-07 for R8, which closes every gap except the Web Push versions of the mails (E14, R9).

**Status legend:**
- **done**: Rotor covers what Streamlit does, or the inventory's planned replacement.
- **partial**: part of it is in Rotor; the "still needed" column says what's missing.
- **missing**: planned (Keep/Merge) but not in Rotor yet.
- **cut**: deliberately not ported (the inventory said Cut, or the item is a CLI/cron concern).

## Summary

| Area | done | partial | missing | cut |
|---|---|---|---|---|
| A. App shell (4) | 2 | 0 | 0 | 2 |
| B. Stats (22) | 22 | 0 | 0 | 0 |
| C. Playlist Modification (7) | 7 | 0 | 0 | 0 |
| D. Playlist Rules (2) | 2 | 0 | 0 | 0 |
| E. Cron/script features in the UI (20) | 16 | 1 | 0 | 3 |
| **Total (55)** | **49** | **1** | **0** | **5** |

After R4 it was 44 / 5 / 0 / 6. R8 moves Skeleton loaders (A), Phantom plays (B22, counted as cut before because it had left the main nav), the weekly digest view (E1), enrichment age (E5) and cron health (E12) to done. The one partial row left is E14, the Web Push versions of the mails, which is R9 (`v0.89-hub-notifications`).

**Before Streamlit can be retired (v1.0):** nothing in Streamlit is missing from Rotor any more once R8 is merged. What R8 added, per former gap:

1. **Phantom plays** (B22): Settings › Data health › Phantom plays (`/settings/health/phantom`). The same population as Streamlit's tab (`track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL`, so podcast episodes count too, and Rotor says how many), the same summary, per-month chart, platform and end-reason breakdowns, and the last 30 plays (up to 300). New: each play links to the identified track played just before and after it.
2. **Data health** (E5, E12): Settings › Data health (`/settings/health`): last ingest per source, cron health per scheduled workflow with GitHub's 60-day auto-disable date (GitHub API, read-only, with the existing dispatch token; "unknown" without it), enrichment coverage (metadata, durations, artist ids, ISRC; audio features are not collected), rollup refresh time, database size against the 500 MB cap, both token expiries, radar source status, phantom count and the last digest.
3. **Weekly digest view** (E1): "This week" (`/digest`, from Library), one week at a time, with the mail's sections and rank arrows. From migration 0029 on, `send_digest` stores every digest before it mails, so the page is complete even when Gmail is down; older weeks are rebuilt from `playlist_rank_history` (Top lists only).
4. **Skeleton loaders** (A): skeletons on Home, Stats, Library, Wrapped and Release radar, with no layout shift (E2E R8-6 measures CLS < 0.02 on each page's first load).
5. **Still open — Web Push versions of the mails** (E14): R9. Not a blocker for retiring Streamlit: the mails come from the crons, not from Streamlit.

## A. App shell (`app.py`)

| Item | Rotor status | Where in Rotor | Still needed |
|---|---|---|---|
| Secrets bridge | cut | Hub server env (`hub/.env.example`, Vercel) | — |
| Skeleton loaders | done (R8) | Route skeletons while a page's data loads (Home, Stats, Library, Wrapped, Release radar, plus This week and Data health), Library rows from the first paint, Home's hero and device strip at their final size before hydration. No layout shift: CLS < 0.02 on first load (E2E R8-6) | — |
| Sidebar "Refresh data" | done | Data comes from rollups refreshed by every ingest (`hub.refresh_rollups`). Stats APIs use a 30 s cache + ETag; Home revalidates on open (SW stale-while-revalidate) | — |
| Navigation (Stats · Playlist Modification · Playlist Rules) | cut | Replaced by Home / Search / Library / Stats (+ Settings, Elsewhere) | — |

## B. Stats (`views/stats.py` + lookups)

| # | Item | Rotor status | Where in Rotor | Still needed |
|---|---|---|---|---|
| B1 | Overview totals row | done | Stats › Overview tiles (`hub.mv_totals`); Home month tiles. Parity checked against Streamlit's SQL in E2E R3-1 | — |
| B2 | Streak row | done | Stats › Overview, Home streak tile (`hub.daily_listening`) | — |
| B3 | Monthly scrobbles chart | done | Stats › Overview "Plays per month" (+ table view) | — |
| B4 | Top tracks/artists (time ranges × 6 ranking modes) | done | Stats › Top, with ▶ play the list and "Save as custom playlist" (R3, guarded) | — |
| B5 | Trends → daily scrobbles | done | Stats › Patterns, daily chart | — |
| B6 | Hour × weekday heatmap | done | Stats › Patterns (`hub.mv_hour_dow`) | — |
| B7 | On this day | done | Home shelf "On this day" + Stats › On this day. Parity checked in E2E R3-2 | — |
| B8 | Year in review | done | Stats › Year. R6 adds the story version (Rotor Wrapped) | — |
| B9 | Artist battle | done | Stats › Compare › Artist battle; artist page "Compare with…" | — |
| B10 | Discovery rate | done | Stats › Overview "New artists per month" | — |
| B11 | Album depth | done | Stats › Top (album depth) | — |
| B12 | Weekend vs weekday | done | Stats › Patterns | — |
| B13 | Listening fingerprint | done | Stats › Overview | — |
| B14 | Records (biggest day, longest gap, milestones, top artist per year) | done | Stats › Records. Milestones checked in E2E R3-4 | — |
| B15 | Period comparison | done | Stats › Compare (year/month A vs B) | — |
| B16 | Achievements | done | Stats › Records (achievements) + Stats › Badges | — |
| B17 | Artist rank race | done | Stats › Top › race | — |
| B18 | Lookup › Track (ISRC variants, heard alongside, badges, liked, end reasons) | done | Track detail page, reachable from every track name | — |
| B19 | Lookup › Album | done | Album detail page (keyed by Spotify album id, not album name; see the R3 PR decisions) | — |
| B20 | Lookup › Artist | done | Artist detail page (every credited artist, badge grid) | — |
| B21 | Spotify tab (hours, by year, skips, platforms, shuffle, end reasons) | done | Stats › Behaviour. Hours use the 0026 duration fallback, the same as Streamlit since #88 | — |
| B22 | Phantom plays | done (R8) | Settings › Data health › Phantom plays: Streamlit's population and breakdowns, last 30 (up to 300) with links to the tracks around each play; count on Data health | — |

## C. Playlist Modification (`views/playlist_modification.py`)

| # | Item | Rotor status | Where in Rotor | Still needed |
|---|---|---|---|---|
| C1 | Make a playlist: filters + preview | done | Library › "New custom playlist" sheet, live count + preview (`hub.custom_playlist_preview`, the same SQL as Python). E2E R2-9 checks the count equals Streamlit's | — |
| C2 | Create on Spotify (` · Custom 🎧`, auto-delete) | done | Same sheet, step 2, through the write guard | — |
| C3 | Manage custom playlists (list) | done | Library › Custom filter, TTL chip | — |
| C4 | Make permanent / extend +7 | done | Playlist header / row menu | — |
| C5 | Delete now | done | Confirm sheet; guard requires the Custom suffix | — |
| C6 | Snapshot force refresh | done | Snapshot playlist › Rebuild (job, or the next daily run) | — |
| C7 | Order preference | done | Updating playlist › sort order chips | — |

Streamlit is read-only since R3: these actions exist only in Rotor.

## D. Playlist Rules (`views/playlist_rules.py`)

| Item | Rotor status | Where in Rotor | Still needed |
|---|---|---|---|
| Summary metrics (16 categories, ~200 playlists) | done | Library › Rules header (rules catalog exported by the daily job) | — |
| Per-category rules + "About this playlist" | done | Rules list by category; "About this playlist" (rule, cadence, next refresh) on each managed playlist | — |

## E. Cron and script features (what the hub shows or triggers)

| # | Feature | Rotor status | Where in Rotor | Still needed |
|---|---|---|---|---|
| E1 | Weekly managed refresh + digest | done (R8) | "Refresh now" per playlist (job); About shows cadence + next refresh; **This week** (`/digest`): "Last refreshed Mon 06:04 · 17 changed", the mail's sections and rank arrows, browsable per week (stored from 0029 on, older weeks rebuilt from rank history) | — |
| E2 | Recently-played ingest + milestone badges + Recently Added | done | Home health dot ("last play synced … ago"), Recent badges shelf, playlist About | — |
| E3 | Liked songs sync | done (no UI by design) | Feeds the liked flag on track pages and the "liked only" filter | — |
| E4 | Missed new tracks | done | Home shortcuts to both Missed-new-tracks playlists. R7's Release radar extends this | — |
| E5 | Track metadata enrichment | done (R8) | Data health › Enrichment: coverage of metadata, durations, artist ids, ISRC, last enriched, N not enriched; audio features marked "not collected" | — |
| E6 | Popularity scores | done (no UI by design) | Feed Top ranking modes and daily-pick recipes | — |
| E7 | Sweep expired custom playlists | done | TTL countdown chip on Custom playlists | — |
| E8 | Period snapshots + `top_1st_*` | done | Home "Fresh" shelf (snapshots first seen in the last 7 days), badges | — |
| E9 | Monthly refresh | done | Rules + About | — |
| E10 | Mid-month Forgotten favourites | done | Rules + About; daily-pick rotation pool | — |
| E11 | Ingest freshness monitor | done | Home header health dot (ok / amber / red) | — |
| E12 | Keepalive | done (R8) | Data health › Crons: state, last run and auto-disable date per scheduled workflow (max(last push, last good keepalive) + 60 days), from the GitHub API | — |
| E13 | Badges (track + artist) | done | Badge grids on detail pages, Stats › Badges, Home Recent badges | — |
| E14 | Mails | partial | Push: daily pick ready, token expiry, job finished (R2). The digests are readable in-app (This week, R8) | Push versions of the weekly/monthly digest, sweep, milestone/badge, snapshot and monitor mails, plus the Gmail fix: R9 |
| E15 | Playlist cover backups | done | Covers shown from the mirror; the backup stays a CLI tool | — |
| E16 | Spotify refresh token | done | Settings › Connections: Reconnect, authorization date, countdown, expiry push | — |
| E17 | Extended history import | cut | CLI only | — |
| E18 | Backfills | cut | CLI only | — |
| E19 | Feature coverage test | cut | — | — |
| E20 | Daily playlist + rotation | done | Home hero, daily pick detail (R1) | — |

No row is missing. E14 is the only partial row, and R9 closes it.

## Retirement checklist (feeds the v1.0 release in `06-roadmap.md`)

1. Merge R8 (`v0.88-hub-parity-gaps`, migration 0029) and, optionally, R9 (`v0.89-hub-notifications`).
2. Run R3's smoke test on your real account (five numbers, On this day, Track badge grid) and R8's (Data health, Phantom plays, This week). E2E already proves parity against Streamlit's SQL on a throwaway DB.
3. Then the v1.0 branch (`v1.0-retire-streamlit`): it deletes `app.py`, `views/`, `.streamlit/` and drops `streamlit`/`altair`, keeping every module the crons import. Deleting the Streamlit Cloud app is a manual step (its PR has the checklist).

### The five deliberately cut items (what you lose with Streamlit gone)

| Item | What you lose |
|---|---|
| A. Secrets bridge (`app.py` copying `st.secrets` into the environment) | Nothing: Rotor reads its own server env (Vercel), the crons read GitHub secrets. Only Streamlit Cloud needed the bridge. |
| A. Navigation (Stats · Playlist Modification · Playlist Rules) | The three-page sidebar layout. Every page behind it exists in Rotor (Home / Search / Library / Stats / Settings). |
| E17. Extended history import | Nothing in the UI had it: it stays a CLI script (`scripts/ingest_spotify_history.py`). |
| E18. Backfills | Nothing: one-off CLI scripts (`scripts/backfill_*.py`, `regenerate_season_boundaries.py`), unchanged. |
| E19. Feature coverage test (`scripts/feature_coverage.py`, only on the unmerged `v0.75-feature-coverage` branch) | Nothing you use today: a manual one-off API probe that never reached `main` or the UI. |

The inventory's sixth cut item, Phantom plays (B22), was ported in R8 instead.
