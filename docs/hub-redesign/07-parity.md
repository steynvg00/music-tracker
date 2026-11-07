# 07 — Streamlit → Rotor parity (after R4)

> Status of every item in `02-inventory.md` once R1–R4 are merged (#86, #87, #88 R3 + 0026, #89 R4). R5 (mixed sessions) is ignored: it may never ship, and nothing here depends on it. R6 (Wrapped) and R7 (Release radar) add features Streamlit never had, so they don't change any row below. Written 2026-11-06 from the code on `v0.84-hub-elsewhere-collections`; no code changes.

**Status legend:**
- **done**: Rotor covers what Streamlit does, or the inventory's planned replacement.
- **partial**: part of it is in Rotor; the "still needed" column says what's missing.
- **missing**: planned (Keep/Merge) but not in Rotor yet.
- **cut**: deliberately not ported (the inventory said Cut, or the item is a CLI/cron concern).

## Summary

| Area | done | partial | missing | cut |
|---|---|---|---|---|
| A. App shell (4) | 1 | 1 | 0 | 2 |
| B. Stats (22) | 21 | 0 | 0 | 1 |
| C. Playlist Modification (7) | 7 | 0 | 0 | 0 |
| D. Playlist Rules (2) | 2 | 0 | 0 | 0 |
| E. Cron/script features in the UI (20) | 13 | 4 | 0 | 3 |
| **Total (55)** | **44** | **5** | **0** | **6** |

**Before Streamlit can be retired (v1.0):** close or explicitly cut what the 5 partial rows and the phantom-plays follow-up (B22) still need, then run the R3 smoke test on your real account. The gaps that matter, ranked:

1. **Phantom plays** (B22 → Settings › Data health): Streamlit's only view of plays whose track was delisted (`track_uri IS NULL`). Rotor has no screen for them. It's the one Streamlit *stats* view with no Rotor equivalent, even though the inventory moved it out of the main nav.
2. **Data health is thin** (E5, E12): Settings shows only the last ingest, the mirror age and whether jobs are on. Missing:
   - keepalive / cron auto-disable date
   - last metadata enrichment
   - DB size against the 500 MB cap (roadmap risks 6 and 8)
3. **Weekly digest view** (E1): "This week: 17 playlists changed", with rank arrows from `playlist_rank_history`. It's only in the Monday mail today; Rotor has no "Last refreshed Mon 06:04" line either.
4. **Web Push equivalents of the mails** (E14): Rotor pushes daily pick, token expiry and job finished. The weekly digest, custom-playlist sweep, milestone and snapshot mails stay e-mail only, and the Gmail failure handling has been broken since 2026-10-21. Not a blocker for retiring Streamlit (the mails come from the crons, not from Streamlit), but nothing reaches your phone when mail is down.
5. **Skeleton loaders** (A): Rotor uses spinners and empty states, not the shelf/row skeletons `05-design.md` specifies. Cosmetic.

None of these block day-to-day use. Rows 1–3 are the real retirement checklist: Data health (phantom plays + cron health + DB size) and the weekly digest view, or a decision to cut the digest.

## A. App shell (`app.py`)

| Item | Rotor status | Where in Rotor | Still needed |
|---|---|---|---|
| Secrets bridge | cut | Hub server env (`hub/.env.example`, Vercel) | — |
| Skeleton loaders | partial | Loading states exist per screen (spinners, "Loading…", empty states) | Skeleton shelves/rows per `05-design.md` §7 (cosmetic) |
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
| B22 | Phantom plays | cut (from the main nav) → **not yet in Data health** | — | A Settings › Data health block: count + last 30 delisted plays (`track_uri IS NULL`). Counted in gap 1 above |

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
| E1 | Weekly managed refresh + digest | partial | "Refresh now" per playlist (job); About shows cadence + next refresh | "Last refreshed Mon 06:04 · 17 changed" line and a **This week** digest view with rank arrows (`playlist_rank_history`). Gap 3 |
| E2 | Recently-played ingest + milestone badges + Recently Added | done | Home health dot ("last play synced … ago"), Recent badges shelf, playlist About | — |
| E3 | Liked songs sync | done (no UI by design) | Feeds the liked flag on track pages and the "liked only" filter | — |
| E4 | Missed new tracks | done | Home shortcuts to both Missed-new-tracks playlists. R7's Release radar extends this | — |
| E5 | Track metadata enrichment | partial | Indirect only (track pages, duration fallback) | Data health line "metadata enriched … ago · N tracks unenriched". Gap 2 |
| E6 | Popularity scores | done (no UI by design) | Feed Top ranking modes and daily-pick recipes | — |
| E7 | Sweep expired custom playlists | done | TTL countdown chip on Custom playlists | — |
| E8 | Period snapshots + `top_1st_*` | done | Home "Fresh" shelf (snapshots first seen in the last 7 days), badges | — |
| E9 | Monthly refresh | done | Rules + About | — |
| E10 | Mid-month Forgotten favourites | done | Rules + About; daily-pick rotation pool | — |
| E11 | Ingest freshness monitor | done | Home header health dot (ok / amber / red) | — |
| E12 | Keepalive | partial | Fixed outside the hub (v0.80.1). Settings has no cron health | Data health: "last scheduled run …, crons auto-disable ≈ …". Gap 2 |
| E13 | Badges (track + artist) | done | Badge grids on detail pages, Stats › Badges, Home Recent badges | — |
| E14 | Mails | partial | Push: daily pick ready, token expiry, job finished (R2) | Push for weekly digest / sweep / milestone / snapshot (optional). Gap 4 |
| E15 | Playlist cover backups | done | Covers shown from the mirror; the backup stays a CLI tool | — |
| E16 | Spotify refresh token | done | Settings › Connections: Reconnect, authorization date, countdown, expiry push | — |
| E17 | Extended history import | cut | CLI only | — |
| E18 | Backfills | cut | CLI only | — |
| E19 | Feature coverage test | cut | — | — |
| E20 | Daily playlist + rotation | done | Home hero, daily pick detail (R1) | — |

No row is fully missing: the weekly digest view is the missing half of E1, which counts as partial because the refresh trigger exists.

## Retirement checklist (feeds the v1.0 release in `06-roadmap.md`)

1. Merge #88 (with 0026 applied) and #89 (0024). R5 is not needed.
2. Decide on gap 3 (weekly digest view): port it, or cut it and keep the Monday mail.
3. Add the Data health items (gaps 1, 2): phantom plays, enrichment age, cron auto-disable date, DB size.
4. Run R3's smoke test on your real account (five numbers, On this day, Track badge grid). E2E already proves parity against Streamlit's SQL on a throwaway DB.
5. Then follow `06-roadmap.md` "v1.0 — Retire Streamlit": delete `app.py`, `views/`, `.streamlit/`, drop `streamlit`/`altair`. `lib/listening_time.py` stays (Rotor's tests and the duration-fallback note use it); move its queries' only remaining caller into the tests, or drop them.
