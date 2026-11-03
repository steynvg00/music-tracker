# 02 — Current-state inventory

> Everything the Streamlit dashboard (`app.py` and its imports) does today, plus the cron and script-only features worth showing in the new hub. Per item: data read, actions triggered, query cost, and a **Keep / Merge / Cut** call with its destination in the hub (screen names refer to `03-ux-ia.md`).

## Legend

**Query cost**: measured with `EXPLAIN ANALYZE` on production (2026-11-03, read-only, 420k `spotify_plays` rows) where marked **m**; otherwise estimated from the query shape.

| Class | Meaning | Typical shape |
|---|---|---|
| ⚡ | < 50 ms | Index range (`played_at >= now()-30d`), single `track_uri`, small tables |
| ◐ | 0.2–1.5 s warm | One pass over `spotify_plays` with `GROUP BY` |
| ● | 1.5–9 s, worst when cold | Full scan + `COUNT(DISTINCT)` / sort spilling to disk / expression filters |

Measured anchors: overview totals **1.1 s warm / 8.9 s cold** (m) · current streak **3.6 s** (m) · on-this-day **4.0 s** (m) · per-track all-time `GROUP BY` **0.63 s** (m) · per-day rollup **0.29 s** (m) · top tracks last 30 days **6 ms** (m) · one track's lifetime stats **23 ms** (m).

**Recommendation**: **Keep** = port as its own thing · **Merge** = fold into another hub screen · **Cut** = don't port (or park in Settings › Data health).

---

## A. App shell — `app.py`

| Item | Data read | Actions | Cost | Recommendation |
|---|---|---|---|---|
| Secrets bridge (`st.secrets` → `os.environ` for `DATABASE_URL`, `SPOTIFY_*`) | — | — | — | **Cut.** Hub has its own server env (`04-architecture.md` §3). |
| Skeleton loaders (`views/_skeleton.py`) | — | CSS | — | **Keep** as a design pattern (skeleton shelves/rows, `05-design.md`). |
| Sidebar "Refresh data" (clears `st.cache_data`, TTL 60 s) | — | cache clear + rerun | — | **Merge** → pull-to-refresh on mobile, refresh icon on laptop; data freshness comes from MVs refreshed by the ingest cron. |
| Navigation: Stats · Playlist Modification · Playlist Rules | — | — | — | **Cut** as structure → replaced by Home / Search / Library / Stats (`03-ux-ia.md`). |

## B. Stats page — `views/stats.py` (12 tabs, 1,519 lines)

| # | Tab → section | Data read | Actions | Cost | Recommendation |
|---|---|---|---|---|---|
| B1 | **Overview** → totals row (total scrobbles, unique tracks, unique artists, date range) | `unified_plays` (4 queries) | — | ● m 1.1 s / 8.9 s | **Keep** → Home stat tiles + Stats › Overview, served from `hub.mv_daily_listening` + a tiny `hub.mv_totals` |
| B2 | Overview → streak row (days listening, current streak, longest streak, avg/day) | `unified_plays` (3 queries, window functions) | — | ● m 3.6 s each streak query | **Keep** → Home "streak" tile. Derive from the 3.5k-row daily rollup (ms) |
| B3 | Overview → Monthly scrobbles bar chart | `unified_plays` GROUP BY month | — | ◐ | **Keep** → Stats › Overview chart (from daily rollup) |
| B4 | **Top tracks/artists** → time range (all/this year/last year/custom year/custom range) × rank by (plays, composite, sticky, evergreen, flash hit, session loop); Top 50 tracks, Top 50 artists | `spotify_plays`, `track_popularity_scores`, `artist_popularity_scores`, `track_metadata` | — | ◐ (all-time) / ⚡ (short windows) | **Keep** → Stats › Top. **New:** ▶ Play the list (as `uris`) and "Save as custom playlist" |
| B5 | **Trends** → Daily scrobbles for a year | `unified_plays` | — | ◐ | **Keep** → Stats › Patterns (daily rollup) |
| B6 | Trends → "When you listen" hour × weekday heatmap | `unified_plays` | — | ◐ | **Keep** → Stats › Patterns (`hub.mv_hour_dow`) |
| B7 | **On this day** → per-year expanders of what you played on this date | `unified_plays` with `EXTRACT(month/day)` filter | — | ● m 4.0 s | **Keep, promote** → Home shelf "On this day". Needs an expression index or MV keyed on `(month, day)` |
| B8 | **Year in review** → top 10 tracks, top 10 artists, monthly distribution | `unified_plays` | — | ◐ | **Keep** → Stats › Year (Wrapped-style story on mobile) |
| B9 | **Deep dives** → Artist battle (A vs B over time) | `unified_plays` | — | ◐ | **Merge** → Artist detail › "Compare with…" |
| B10 | Deep dives → Discovery rate | `unified_plays` first-play per artist | — | ◐ | **Merge** → Stats › Overview "New artists per month" |
| B11 | **Personality** → Album depth (radio: rank by) | `spotify_plays`, `track_metadata` | — | ◐ | **Keep** → Stats › Personality |
| B12 | Personality → Weekend vs weekday | `unified_plays` | — | ◐ | **Keep** → Stats › Personality |
| B13 | Personality → Listening fingerprint | `unified_plays` | — | ◐ | **Keep** → Stats › Personality |
| B14 | **Records** → Biggest single day, Longest gap, Scrobble milestones, Top artist of each year | `unified_plays` | — | ◐–● | **Keep** → Stats › Records (daily rollup makes biggest-day and gap ms-cheap) |
| B15 | **Highlights** → Period comparison (year or month A vs B) | `unified_plays` | — | ◐ | **Merge** → Stats › Compare |
| B16 | Highlights → Achievements (metric tiles incl. "Marathon day") | `unified_plays`, `badge_events` | — | ◐ | **Merge** → Badges (Stats › Badges + detail pages) |
| B17 | Highlights → Artist rank race | `unified_plays` | — | ◐ | **Keep (laptop-first)** → Stats › Top › "Race" toggle |
| B18 | **Lookup › Track** (`_stats_track_lookup.py`) → search; plays, first/last play, skip rate, end-reason labels, liked flag, URI variants under one canonical (ISRC), "heard alongside", badges grid (`_badge_display.py`) | `spotify_plays`, `track_metadata` (canonical/ISRC), `liked_songs`, `badge_events` | — | ⚡ m 23 ms core + ◐ for "heard alongside" | **Keep, upgrade** → **Track detail page** (drill-in from every track row). The single most valuable stats feature to port |
| B19 | Lookup › Album (`_stats_album_lookup.py`) → plays per month, tracks in album (canonical-aware) | `spotify_plays`, `track_metadata` | — | ◐ | **Keep** → Album detail page |
| B20 | Lookup › Artist (`_stats_artist_lookup.py`) → headline metrics + artist badge grid | `spotify_plays`, `track_metadata` (`unnest(artist_ids, artist_names)`), `badge_events` | — | ◐ | **Keep** → Artist detail page |
| B21 | **Spotify** → overview (plays, hours, range, distinct tracks), listening time by year, skip analysis, platform breakdown, shuffle behaviour, end-of-play reasons | `spotify_plays` rich fields | — | ◐ each (6+ scans) | **Merge** → Stats › Behaviour (one MV: `hub.mv_behaviour_daily`) |
| B22 | **Phantom plays** (`_stats_phantom_plays.py`) → catalogue-delisted plays over time, breakdown, last 30 | `spotify_plays WHERE track_uri IS NULL AND …` | — | ◐ | **Cut** from main nav → Settings › Data health |

## C. Playlist Modification page — `views/playlist_modification.py`

| # | Item | Data read | Actions triggered | Cost | Recommendation |
|---|---|---|---|---|---|
| C1 | **Make a playlist** → filters: artists (top 2,000 by plays), release-year range, discovery-year range, min plays, max tracks, liked only, sort (7 options) → **Preview** | `spotify_plays`, `track_metadata`, `liked_songs` via `lib.temporary_playlists.query_temp_playlist_tracks` | — | ◐ (artist `ILIKE '%…%'` ORs + `HAVING`) | **Keep** → "New custom playlist" sheet with live count + preview. Port the SQL to a Postgres function so Python and TypeScript share one copy (`04-architecture.md` §4) |
| C2 | Make a playlist → **Create on Spotify**: name + ` · Custom 🎧`, auto-delete after N days (default 7; 0 = permanent) | — | Spotify: `current_user`, create playlist, add items in batches of 100; DB: `INSERT custom_playlists` | ⚡ DB / ~3–6 Spotify calls | **Keep** → same sheet, step 2. Uses `POST /me/playlists` (restricted-set compatible) |
| C3 | **Manage custom playlists** → list with created/expires/track count | `custom_playlists` | — | ⚡ | **Keep** → Library › filter "Custom", TTL chip on each row |
| C4 | → Make permanent / Extend +7 days | — | `UPDATE custom_playlists.expires_at` | ⚡ | **Keep** → row menu + playlist header |
| C5 | → Delete now (two-click confirm) | — | Spotify unfollow (`current_user_unfollow_playlist`) + `DELETE FROM custom_playlists` | ⚡ | **Keep** → destructive action with confirm sheet. Only on `· Custom 🎧` playlists (hard rule 3) |
| C6 | **Manage snapshot** → grouped (Monthly Top 25 / Seasonal Top 50 / Yearly Top 100 / All-Time Top 100), status (pending / last refreshed), **Force refresh** | `playlist_settings`, `lib.playlists.get_snapshot_definitions` | `request_force_refresh` → next cron rewrites the snapshot. Fallback: paginates `GET /me/playlists` to find the ID | ⚡ DB; fallback ~5+ Spotify calls | **Merge** → snapshot playlist detail › ⋯ › "Rebuild at next refresh". Hub resolves IDs from its own playlist mirror (no pagination) |
| C7 | **Manage updating** → per playlist order preference (10 options from `ORDER_PREF_OPTIONS`) | `playlist_settings`, `get_updating_definitions` | `upsert_order_pref` (applied at next cron) | ⚡ | **Merge** → updating playlist detail › "Sort order" chip row, with "applies at next refresh (Mon 06:00)" hint |

## D. Playlist Rules page — `views/playlist_rules.py`

| Item | Data read | Actions | Cost | Recommendation |
|---|---|---|---|---|
| Summary metrics: categories (16), managed playlists (~200), "without cron" | `lib.playlists.describe_playlist_categories` (pure data + DB for dynamic definitions) | — | ◐ (builds dynamic definitions) | **Keep** → Library › Managed › "Rules" header |
| Per-category table: rule in Dutch (`rule_nl`), schedule, next snapshot creation, query source code | same | — | — | **Merge** → (a) Rules list grouped by category; (b) on each managed playlist detail an "About this playlist" block with the rule, cadence and next refresh. Cache 1 h |

## E. Cron and script-only features users would want in the UI

The cron schedule from `.github/workflows/scheduled-ingest.yml`, with what the hub should show or trigger. **Important for any "Refresh now" button:** every job in that workflow is gated `if: github.event_name == 'workflow_dispatch' || …`. A manual `workflow_dispatch` therefore runs **all ten jobs at once**, including the weekly ~200-playlist rewrite and the snapshot job. The hub needs a separate, input-driven workflow (proposed in `06-roadmap.md`, R2) before it can offer targeted refreshes.

| # | Feature (script) | When | Data | Spotify actions | UI value | Recommendation |
|---|---|---|---|---|---|---|
| E1 | Weekly managed refresh (`update_managed_playlists.py --fresh-ingest`) + weekly digest mail | Mon 06:00 UTC | all definitions in `lib/playlists.py`, `playlist_settings`, `playlist_rank_history` | ~200 × (find/create + replace + add batches) | High: "what changed this week" | **Keep** cron. Hub shows "Last refreshed Mon 06:04 · 17 playlists changed" and a **This week** digest view (rank arrows from `playlist_rank_history`) |
| E2 | Recently-played ingest (`ingest_spotify_recent.py`) + milestone badges (`lib/badges.py`) + Recently Added maintenance (`lib/recently_added_manager.py`: purge > 90 days, auto-like) | every 30 min (GitHub delivers irregularly: today's runs landed at 03:15, 10:29, 11:09, 11:10, …) | `spotify_plays`, `badge_events`, Recently Added playlist | recently-played, playlist items, library contains/add | Medium | **Keep** cron. Hub: freshness pill ("synced 12 min ago"), "Recent badges" shelf, Recently Added rules shown on that playlist |
| E3 | Liked songs sync (`sync_liked_songs.py`) | daily 03:00 | `liked_songs` | `/me/tracks` | Low | **Keep** cron, no UI |
| E4 | Missed new tracks (`daily_missed_tracks_refresh.py`) | daily 03:00 | followed artists + releases | followed artists, artist albums, album tracks, playlist replace | High | **Keep** cron. Hub: Home shelf "New from artists you follow" (plays the two managed playlists) |
| E5 | Track metadata enrichment (`enrich_track_metadata.py`) | daily 03:30 | `track_metadata` | batch `GET /tracks` (still works on this Client ID, see `01-feasibility.md` I5) | None directly | **Keep** cron. Data health only |
| E6 | Track + artist popularity scores (`compute_*_popularity_scores.py`) | daily 03:50 / 03:55 | `track_popularity_scores`, `artist_popularity_scores` | — | Feeds ranking + daily-pick recipes | **Keep** cron. Hook point for the daily-pick generator (`04-architecture.md` §4) |
| E7 | Sweep expired custom playlists (`sweep_expired_custom_playlists.py`) + sweep mail | daily 04:00 | `custom_playlists` | unfollow | Medium | **Keep** cron. Hub: TTL countdown chip ("deletes in 3 d") |
| E8 | Period snapshots (`create_snapshots.py`) + snapshot mail + `top_1st_*` badges | daily 05:00 (acts on period ends) | `spotify_plays`, `badge_events` | create playlist + add | High | **Keep** cron. Hub: Home card "New snapshot: Top 25 · October 2026" for 7 days after creation |
| E9 | Monthly refresh: Top 100 this year, Top 100 all-time, My Monthly #1 (`monthly_playlist_refresh.py`) | 1st, 06:00 | as E1 | replace | Medium | **Keep** cron. Visible in Rules + playlist "About" |
| E10 | Mid-month: Forgotten favourites (`mid_month_playlist_refresh.py`) | 15th, 06:00 | as E1 | replace | High (rotation ingredient) | **Keep** cron. Strong daily-pick candidate |
| E11 | Ingest freshness monitor (`check_ingest_freshness.py`, separate workflow) | daily 21:13 | `max(played_at)` vs Spotify's newest | recently-played (limit 1) | High | **Keep** cron. Hub: header health dot (green / amber "ingest 3 h behind" / red) |
| E12 | Keepalive (`keepalive.yml`) | 1st, 07:17 | — | — | High, because it is **broken** (`01-feasibility.md` I1) | **Fix outside the hub.** Hub: Data health shows "last repo push 2026-09-29 · crons auto-disable ≈ 2026-11-28" |
| E13 | Badges: track milestones (`plays_50…500`), special badges, `top_1st_*`, 21 artist badges (`lib/artist_badges.py`); PNG icons in `assets/badges/` | with E2/E8 | `badge_events` | — | High (fun) | **Keep** → badge chips on track/artist detail, Stats › Badges, Home "Recent badges" |
| E14 | Mails: weekly digest, sweep, milestone, snapshot (`lib/email_notify.py`, `lib/snapshot_notify.py`) | with crons | — | — | Medium | **Keep** mails. Later: optional Web Push equivalents |
| E15 | Playlist cover backups (`download_playlist_covers.py`, `cover_backup/`) | manual | managed playlists' covers | playlist images | Medium | **Merge**: managed playlists show their Spotify cover image (already uploaded). The backup stays a CLI tool |
| E16 | Spotify refresh token (`scripts/spotify_auth.py`, loopback redirect, manual paste into `.env` + GitHub secret) | manual | — | OAuth | **Critical** (6-month expiry, `01-feasibility.md` §0.2) | **Replace** with the hub's Settings › Connections: reconnect button, authorization date, countdown |
| E17 | Spotify Extended history import (`ingest_spotify_history.py`) | manual, rare | JSON export | — | Low | **Cut** from UI (CLI stays) |
| E18 | Backfills (`backfill_*.py`, `regenerate_season_boundaries.py`) | manual one-offs | — | — | None | **Cut** |
| E19 | Feature coverage test (`scripts/feature_coverage.py`, unmerged branch `v0.75-feature-coverage`) | manual | — | single `GET /tracks/{id}` | None | **Cut** from UI |
| E20 | **Daily playlist + rotation** | does not exist yet | — | — | Core of the vision | **New** (R1): generator in Python, Rotate/Play in the hub |

## F. Totals and the map to the hub

| | Keep | Merge | Cut | New |
|---|---|---|---|---|
| Shell (A) | 1 | 1 | 2 | — |
| Stats (B, 22 items) | 15 | 6 | 1 | ▶ play/save from any list |
| Playlist Modification (C, 7) | 5 | 2 | 0 | — |
| Playlist Rules (D, 2) | 1 | 1 | 0 | — |
| Cron/script (E, 20) | 13 shown in UI | 1 | 4 | daily pick, health, digest view, token management |

Hub destination summary:
- **Home** ← B1, B2, B7, E4, E8, E13, E20 (+ remote control)
- **Library** ← C3–C7, D, E1, E9, E10, playlist mirror (`spotify_playlists`)
- **Track / Album / Artist detail** ← B9, B18–B20, E13
- **Stats** ← B3–B6, B8, B10–B17, B21
- **Settings** ← E11, E12, E16, B22 (Data health, Connections)

## G. Things the inventory surfaced that matter for the redesign

1. **No UI reads `custom_playlists.filters_summary` back into filters.** "Edit a custom playlist" therefore needs the filters stored as JSON (`04-architecture.md` §5, migration 0021).
2. **Managed-playlist IDs are only known via `playlist_settings` (223 rows) or by paginating Spotify.** The hub needs a nightly mirror of your playlists (ID, name, owner, snapshot ID, image, track count, managed flag) so it never paginates in a request and can enforce the read-only rule.
3. **Every Streamlit write goes straight to the DB with the owner role**, and the dashboard has no login of its own: `docs/streamlit-cloud-deploy.md` deploys it as a *public* app, so it relies on the obscurity of the URL, and anyone who has it can create or delete custom playlists. The hub must add real auth, because it can *control playback* and *delete playlists* (`04-architecture.md` §3).
4. **All heavy stats re-scan `spotify_plays` on every cache miss** (TTL 60 s). Precomputed rollups refreshed after each ingest are the single biggest performance win (`04-architecture.md` §6).
