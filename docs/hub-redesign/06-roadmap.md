# 06 — Roadmap, risks, open questions

## Baseline

- `main` = `0eea1cd`, tag **`v0.80-rls-remaining-tables`** (2026-09-29). Hub releases continue from there.
- The unmerged local branch `v0.75-feature-coverage` (feature-coverage test) is not part of this plan. If it merges first it takes v0.81; shift the numbers below by one.
- Per release: **one branch, one commit, one tag**. That fits CLAUDE.md: PR + squash-merge into protected `main`, then `git tag vX && git push --tags`. Migrations are applied by hand in the SQL editor before the release that needs them is deployed.
- Build-time estimates are **Claude Code working time** (including its own testing), not calendar time. Your review, migrations and device testing come on top.

## R0 — Prerequisites, outside the hub (do these first)

`v0.80.1-ops-keepalive-and-token` · ~1 h

| | |
|---|---|
| Scope | (1) Fix the keepalive: pushing to protected `main` is rejected (`GH013`). Switch it to re-enabling the workflows via the GitHub API (`PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable`, `permissions: actions: write`), the approach used by keepalive actions that avoid commits; verify that it resets the 60-day timer. Until then, merging any PR resets the timer. (2) Re-mint the Spotify refresh token now, with the R1 scope set included so you don't have to re-consent twice, and update the GitHub secret + `.env`. Record the date in `docs/cron-setup.md`. |
| Files | `.github/workflows/keepalive.yml`, `docs/cron-setup.md`, `scripts/spotify_auth.py` (scope list) |
| Migrations | — |
| Smoke test | `gh run list --workflow keepalive.yml` → success; `gh api repos/steynvg00/music-tracker/actions/workflows --jq '.workflows[] \| [.name,.state]'` → all `active`; next */30 ingest green with the new token |
| Deadline | **Before ≈ 2026-11-21** (token) and **≈ 2026-11-28** (cron auto-disable) |

## R1 — Remote control + Home with today's pick (biggest win)

`v0.81-hub-remote-and-daily-pick` · **~9 h** · branch `v0.81-hub-remote-and-daily-pick`

| | |
|---|---|
| Scope | SvelteKit PWA scaffold in `hub/` on Vercel (`fra1`), manifest + service worker + safe areas. **Login with Spotify** + owner gate + hashed sessions. **Token store** with authorization date, countdown and Reconnect (Settings › Connections). **Player**: proxy routes, adaptive-polling store, optimistic commands, mini-player / player bar / full-screen player, **device picker** with the pending-intent wake flow, **"This laptop"** via Web Playback SDK. **Playlist mirror** (nightly Python + on-demand). **Daily pick**: Python generator (5 candidates/day), Home hero with Play / Rotate / Shuffle-the-deck, daily-pick detail, writes only to `Daily pick · Auto 🤖🔄` through the write guard. Home v1: device strip, hero, shortcuts, three ⚡ stat tiles (plays this week, hours this week, top artist this month; all index-range queries), Fresh shelf, Coming back around. Cron token option A (if chosen, Q4). |
| Files | `hub/**` (new: `src/lib/server/spotify/{oauth,token,player,write-guard}.ts`, `src/lib/stores/player.svelte.ts`, `src/routes/(app)/{+layout,home,daily}/…`, `src/routes/api/{auth,player,daily,home}/…`, `static/manifest.webmanifest`, `src/service-worker.ts`, `hub/.env.example`); `scripts/generate_daily_picks.py`, `scripts/sync_playlist_mirror.py` (new); `lib/daily_picks.py` (new, recipes); `lib/spotify.py` (token from DB, env fallback); `.github/workflows/scheduled-ingest.yml` (two jobs: `30 4 * * *` daily picks, `15 4 * * *` mirror); `README.md` |
| Migrations | `0019_hub_auth.sql`, `0020_spotify_playlist_mirror.sql`, `0021_daily_picks.sql` |
| Spotify dashboard | Add redirect URI `https://<rotor>.vercel.app/auth/callback`; scopes per `01-feasibility.md` §1.1 |
| **Spike tests (measure, then write results into `01-feasibility.md`)** | (a) command → audible latency on iPhone, speaker, This laptop (10 samples each); (b) requests/hour while open + any `429`; (c) how long until an idle iPhone drops off `/me/player/devices`; (d) does `context_uri` of a Spotify-owned playlist play? (e) Web Playback SDK in iPhone standalone PWA: start after a tap, survive lock? |
| Smoke test | 1. Non-owner Spotify account → rejected after OAuth. 2. Today's pick › Play → plays on the active iPhone within 2 s, mini-player shows "⌁ iPhone". 3. Rotate ×4 → each < 1 s, no Spotify call (network tab). 4. Start a playlist in the Spotify app on the speaker → Rotor shows it within 5 s and can pause/skip/seek. 5. Kill Spotify on the phone → Play → "Spotify isn't open anywhere" → Open Spotify → plays without a second tap. 6. Laptop: pick "This laptop" → audio in Chrome; media keys work. 7. `grep -r "$SPOTIFY_CLIENT_SECRET" hub/.svelte-kit/output/client` → nothing. 8. Write-guard unit tests: unmanaged / not-owned / suffix-spoofed playlist → `ReadOnlyPlaylist`. 9. Hidden tab → zero player requests after 10 s. |

## R2 — Playlists, custom playlists, rules

`v0.82-hub-playlists-and-rules` · **~6 h**

| | |
|---|---|
| Scope | Library (Spotify source): chips, sort, kind badges, read-only lock. Playlist detail with "About this playlist" (rule, cadence, next refresh). **Custom playlists**: create (filters → live count → preview → name + lifetime), edit (prefilled from `filters_json`), extend / keep / delete. **Managed settings**: order preference, snapshot rebuild. **Rules** view (16 categories). **Jobs**: `hub_jobs` + `hub-jobs.yml` (input `job_id`) for "Refresh this playlist now" and "Shuffle the deck". Web Push: daily pick ready, token expiring, job finished. |
| Files | `hub/src/routes/(app)/{library,playlist/[id],rules}/…`, `hub/src/lib/components/custom-playlist-sheet/…`, `hub/src/routes/api/{custom,playlists,jobs,push}/…`; `lib/temporary_playlists.py` (call the SQL function); `scripts/update_managed_playlists.py` (`--only <playlist_id>`); `scripts/run_hub_job.py` (new); `.github/workflows/hub-jobs.yml` (new); README |
| Migrations | `0022_hub_jobs_and_push.sql` (+ `hub.custom_playlist_preview(filters jsonb)` SQL function in the same file) |
| Smoke test | 1. Create "Smoke test · Custom 🎧", 7 days → appears in Spotify with suffix, row in `custom_playlists` with `filters_json`. 2. Edit → remove 2 tracks → Spotify reflects it. 3. Extend +7 → `expires_at` moves. 4. Delete → gone from Spotify and DB. 5. Try to open Edit on an unmanaged playlist → no affordance. API call returns 403. 6. Order pref "Random" on *Top 30 last 30 days* → applied after the next run of that playlist via "Refresh now" (job goes queued → running → done in < 3 min). 7. Rules shows 16 categories, ~200 playlists, same counts as the Streamlit page. 8. The same preview filters give the same track count in Streamlit and Rotor. |

## R3 — Stats parity (+ Streamlit goes read-only)

`v0.83-hub-stats-parity` · **~10 h**

| | |
|---|---|
| Scope | Rollups (`hub` schema MVs, refresh after every ingest) + `hub.home_payload()`. **Stats**: Overview, Top (all ranking modes and time ranges, ▶ play / save as custom), Patterns (daily + heatmap), Year in review, Records, Behaviour (skip, platform, shuffle, end reasons), Compare, Badges. **Track / Album / Artist detail** (ported Lookup incl. canonical/ISRC variants, heard alongside, badge grids). **Search** over your history. Home: streak tile, On this day, Recent badges. Streamlit: one-line "Moved to Rotor" banner per page and its write buttons removed. |
| Files | `hub/src/routes/(app)/{stats/**,track/[uri],album/[id],artist/[id],search}/…`, `hub/src/lib/server/db/stats.ts`, chart components; `scripts/ingest_spotify_recent.py` (+ `SELECT hub.refresh_rollups()`); `views/*.py` (banner + remove write buttons), `app.py` |
| Migrations | `0023_hub_stats_rollups.sql` |
| Smoke test | 1. Five numbers identical in Streamlit and Rotor: total plays, current streak, top-10 tracks this year, plays of one chosen track, plays of one chosen artist. 2. `/api/home` server time < 100 ms (log). 3. `hub.refresh_rollups()` < 5 s in the ingest log. 4. On this day for today matches Streamlit's tab. 5. Track detail shows the badge grid identical to the Streamlit lookup. 6. Lighthouse PWA + a11y on Home ≥ 90 (mobile). |

## R4 — YouTube + SoundCloud collections ("Elsewhere")

`v0.84-hub-elsewhere-collections` · **~5 h**

| | |
|---|---|
| Scope | Library source switch (Spotify · YouTube · SoundCloud). Import a YouTube playlist (public/unlisted URL, API key) or a SoundCloud set (URL, oEmbed, no key). Collection detail with the **visible** YouTube IFrame player (≥ 480×270 laptop right panel, full-screen sheet on mobile) or the SoundCloud widget. Next/previous within one collection only. Embeddability and Go+-preview flags. 30-day metadata refresh (YouTube III.E.4). Home gets only the "Elsewhere" link card (unless Q1 says otherwise). |
| Files | `hub/src/routes/(app)/elsewhere/**`, `hub/src/lib/players/{youtube,soundcloud}.ts`, `hub/src/routes/api/collections/…`; `scripts/refresh_collections.py` (new, nightly); `.github/workflows/scheduled-ingest.yml` (one job) |
| Migrations | `0024_media_sources.sql` |
| Smoke test | 1. Import an unlisted YouTube playlist (≥ 20 items) → items listed, quota use < 5 units. 2. Play → visible player, ENDED advances to the next item; locking the iPhone stops playback (expected, documented). 3. A non-embeddable video is flagged at import and skipped with a toast. 4. Import a SoundCloud set → plays through the widget, FINISH advances. 5. No YouTube/SoundCloud item appears in any Spotify list, shelf or queue. 6. Rows older than 30 days get refreshed by the nightly job. |

## R5 — Mixed sessions (optional, last feature, policy-gated)

`v0.85-hub-mixed-sessions` · **~7 h** · only if Q3 = yes

| | |
|---|---|
| Scope | Mix lists (separate type, Elsewhere only), the conductor state machine (`01-feasibility.md` §6.2), laptop-first with Spotify on "This laptop" (SDK), precondition checks (same output device), pre-cueing, all handoff failure UIs (`03-ux-ia.md` flow f), `handoff_events` telemetry + session summary. iPhone: Relay mode via Web Push. Per-device opt-in with policy warning. |
| Files | `hub/src/lib/conductor/**`, `hub/src/routes/(app)/elsewhere/mix/[id]/…`, `hub/src/routes/api/mix/…`, push relay route |
| Migrations | `0025_mixes.sql` |
| Smoke test | 1. Laptop mix S-S-YT-S-SC-S: all handoffs succeed, median gap ≤ 2 s (from `handoff_events`). 2. Spotify device = speaker → start blocked with the "music would jump rooms" choice. 3. Skip a track in the Spotify app mid-run → "Mix paused" banner, Resume works. 4. Device Autoplay on → Rotor pauses Spotify radio within one poll. 5. iPhone locked during a Spotify run → push arrives at run end; tap → "Tap to continue on YouTube". 6. Opt-in off → no mix UI anywhere. |

## R6 — Rotor Wrapped (full-year review)

`v0.86-hub-wrapped` · **~8 h** · stacked on R4 (R3 + 0026 hours fix), **not** on R5

| | |
|---|---|
| Scope | A Wrapped-style year review over the **full calendar year** (Spotify's own Wrapped stops around the end of October), called **Rotor Wrapped** (own look, no Spotify logo, no Wrapped name assets). Two modes: **Wrapped ‹year›** is built on 1 January (Europe/Amsterdam) for the previous year and stored as a **frozen snapshot**, so it never changes afterwards; any past year since 2017 can be built on demand, and is frozen too. **Wrapped so far** is the current year, computed live from the rollups. |
| Content (cards; a card without data is skipped) | Total plays + listening time. Hours use the 0026 duration fallback and are marked "≈" when the year has API plays without `ms_played`. Top 5 and top 100 tracks and artists with plays + hours. New discoveries (first-ever plays this year). Comebacks: tracks/artists back after ≥ 12 months away. Longest streak this year. Biggest day. Listening clock (hour × weekday). Favourite month. Badges earned this year. Year over year vs the previous year. *Hardstyle subgenre breakdown:* only with a usable genre/tag source in the DB. **There is none today**, so the card is omitted. |
| Data | One SQL function, `hub.wrapped_payload(year, through)`, over the R3 rollups (`hub.day_track`, `hub.daily_listening`, `hub.mv_*_first`) + `spotify_plays` (one year's range, for the clock and the "≈" count) + `badge_events`. Frozen years: `wrapped_snapshots(year PK, payload jsonb, …)`, written only by `hub.wrapped_freeze(year)`, which never overwrites. A trigger refuses UPDATE. |
| Jobs | New hub job kind `wrapped_build` (payload `{year}`), for "Build this year" in Stats. The existing daily `hub-jobs.yml` run builds the previous year when its snapshot is missing (so on 1 January, and self-healing after a failed run) and sends one "Your Rotor Wrapped ‹year› is ready" push. `scheduled-ingest.yml` is not touched. |
| UI | Story player: fullscreen cards, tap left/right + swipe on iPhone, ← / → on the laptop, segmented progress bar, hold (or Space) to pause, Esc closes. Every card can be saved/shared as a PNG rendered client-side (the card is an SVG; SVG → canvas → PNG, no new dependencies). Entry points: a Home card from 1 December through 31 January (December: *so far*; January: last year), and a permanent **Stats › Wrapped** with a year picker. "Play your top 100" creates or replaces `Wrapped ‹year› · Auto 🤖📸` through the write guard (that one managed playlist, nothing else) and plays it. |
| Files | `migrations/0027_wrapped.sql`; `lib/wrapped.py`, `lib/hub_jobs.py` (kind + daily step); `hub/src/lib/server/wrapped.ts`, `hub/src/lib/shared/wrapped.ts`, `hub/src/lib/wrapped/cards.ts` (SVG cards + PNG export), `hub/src/routes/wrapped/[year]/…` (story, outside the app shell), `hub/src/routes/(app)/stats/wrapped/…`, `hub/src/routes/api/wrapped/…`; Home card; `docs/hub-redesign/07-parity.md` |
| Migrations | `0027_wrapped.sql`: additive, **plus one widening**: `hub_jobs.kind` CHECK gains `wrapped_build`. The new list also keeps R5's `mix_relay`, so 0027 works with or without 0025. Applies after 0026, without 0025. |
| Performance budget | Building one year at production size: seconds, far inside a GitHub Actions run. *So far*: < 300 ms. |
| Smoke test | 1. Stats › Wrapped lists 2017 → this year. This year opens *so far* with today's date in the intro card. 2. Pick last year → "Build" → job runs → story opens; build again → same snapshot (`generated_at` unchanged). 3. Tap/swipe/arrow through every card; hold pauses; progress bar matches. 4. Save a card → PNG in Photos / Downloads, no Spotify logo. 5. "Play your top 100" → `Wrapped ‹year› · Auto 🤖📸` in Spotify with 100 tracks, playing on the active device; a second press replaces it, no new playlist. 6. Top-5 numbers equal Stats › Year for the same year. 7. On 1 January: the daily run builds last year and one push arrives. 8. Home shows the Wrapped card in December/January only. |

## R7 — Release radar

`v0.87-hub-release-radar` · **~8 h** · stacked on R6

| | |
|---|---|
| Scope | Upcoming and new releases from the artists you actually listen to: your top ~200 artists by plays over the last 24 months (`RADAR_TOP_ARTISTS`, `RADAR_WINDOW_MONTHS`) plus artists you mark **Follow in Rotor**. |
| Sources (one adapter each, own `last_success_at` + error state) | (1) **Spotify Web API** `GET /artists/{id}/albums` (album + single, last 60 days), cron app token. It is not on the Feb 2026 restricted list (`01-feasibility.md` §0.1), and `lib/missed_new_tracks.py` already calls it daily in production → enabled. (2) **MusicBrainz**: artist via its Spotify URL relationship (`/ws/2/url`), else a unique exact name match; releases dated from 60 days ago to 1 year ahead. 1 request/second, `User-Agent: RotorMusicHub/0.87 ( https://github.com/steynvg00/music-tracker )`, no e-mail address in headers. (3) **Label pages**: one parser per label, starting with Scantraxx's monthly overview (`scantraxx.com/news/releases-scantraxx-<month>-<year>`): this month + next month, one request per page, seconds apart, once a day; stores only artist, title, label, date, URL. Beatport is out of scope. |
| Matching | Normalised artist + normalised title (feat./mix/edit tags stripped) + a ±14-day date window merges one release across sources. Status at read time: **announced** (date in the future), **out**, **in your library** (a track of it played or liked). |
| Jobs | A step in the existing daily `hub-jobs.yml` run (no new job kind, no workflow change except env lines). A source failing 3 daily runs in a row sends **one** Web Push (reuses R2 push), not one per day. |
| UI | **Release radar** screen: Coming up (by date), Recently out, per-artist filter, source health. Compact **Coming up** shelf on Home. **Follow in Rotor** toggle on artist pages. Optional playlist `New from your artists · Auto 🤖🔄` (Spotify releases of the last 14 days), written through the write guard on request. |
| Files | `migrations/0028_release_radar.sql`; `lib/release_radar/` (`__init__`, `artists`, `match`, `store`, `sources/{spotify,musicbrainz,scantraxx}`); `lib/hub_jobs.py` (daily step); `tests/fixtures/release_radar/*` (saved HTML/JSON); `hub/src/lib/server/radar.ts`, `hub/src/routes/(app)/radar/…`, `hub/src/routes/api/radar/…`; Home shelf; artist page toggle |
| Migrations | `0028_release_radar.sql`: additive only (tables + indexes). |
| Smoke test | 1. Daily run → Radar shows per-source "last success" for Spotify, MusicBrainz, Scantraxx. 2. A release known to two sources shows once, with both source badges. 3. A release you already played shows "In your library". 4. Follow an artist outside your top 200 → their releases appear after the next run. 5. Home "Coming up" lists the next announced releases. 6. "Update playlist" → `New from your artists · Auto 🤖🔄` holds the last 14 days of Spotify releases. 7. A source failing three days in a row → exactly one push. |

## v0.90 — Artist pages (beta), Spotify catalog search, storage-light cache, database diet

`v0.90-hub-artist-pages-beta` · after R9 (#97), independent of v1.0 (#98) and R5 (#90)

| | |
|---|---|
| Scope | **Artist pages (beta)**, per-device flag in Settings › Experimental (off by default; off = nothing changes). Header with your numbers (plays, hours, first/last played, tracks played, badges) + "Full stats & badges" (the R3 page). Discography from Spotify with nothing hidden: Albums, Singles & EPs, Compilations, Appears on, all on the page, newest/oldest first, year headers, cover/title/date/type/track count/your state per release. Own releases expand to their tracklist; Appears on shows only this artist's tracks + "Show full album". Every track row: ▶ (Spotify Connect) and "From here" (album context). Artist links everywhere lead there with the flag on. **Search › Spotify** (same flag): artists, albums, tracks, 10 per request, "Load more". Album page with your state per track. |
| Storage | `0031_artist_catalog_cache.sql`: one compact jsonb row per opened artist, appears-on own tracks in never-rewritten batches, 7-day TTL, 20 MB cap with LRU eviction, hit-rate counters (Data health). Full tracklists are never stored. |
| Database diet | `0032_index_diet.sql` (three unused indexes, proven by replaying every E2E query with `enable_seqscan = off`); `scripts/archive_scrobbles.py` (CSV.gz + checksums, read-only) and `0033_drop_scrobbles_AFTER_ARCHIVE.sql` (manual, guarded by the archive's row count). Data health warns above 450 MB. |
| Policy note | Catalog browsing is what Developer Policy III.11 warns about (`01-feasibility.md` §0.3), which is why all of it stays behind the opt-in beta flag and every page carries the Spotify attribution + "Open in Spotify". |

## v1.0 — Retire Streamlit

`v1.0-rotor` · **~1.5 h** · after R7 (was "R6" in the first plan; Wrapped and Release radar took R6/R7). Gaps to close first: `07-parity.md`.

| | |
|---|---|
| Scope | Remove the dashboard. Keep every `lib/` module the crons still import. Delete the Streamlit Cloud app (manual step for you). Update docs. |
| Files | delete `app.py`, `views/`, `.streamlit/`, `docs/streamlit-cloud-deploy.md`; `pyproject.toml` / `uv.lock` (drop `streamlit`, `altair` if unused elsewhere); `CLAUDE.md` (stack, key files); `README.md` |
| Migrations | — |
| Smoke test | 1. `uv sync --frozen` + a dry run of every cron script entry point imports cleanly (`python -c "import scripts.<x>"` for each). 2. Next */30 ingest, nightly jobs and Monday refresh green. 3. `grep -rn "import streamlit" lib scripts` → nothing. 4. Old Streamlit URL gone. Rotor covers every "Keep/Merge" row in `02-inventory.md` (checklist). |

## v0.91 — Library organiser (one filter bar, pins, folders, Manage)

`v0.91-hub-library-organiser` · after v1.0 · independent of v0.90 (#99)

| | |
|---|---|
| Scope | **One filter bar** (`PillBar`, shared by Library and Stats): Spotify-style pills in one scrollable row, × to clear, ▾ menu pills for long choices, the sort/view (Library) or metric (Stats) icon button at the end opening a sheet. Library: source + kind pills, sort (A–Z, recently played, recently added, track count, custom order) and list/grid in the sheet, search one tap away in the header, "+" for a new custom playlist or folder. Rules / Release radar / This week moved out of the Library: Release radar + This week on Home, Rules in Settings (and Library › Rules-based). Stats: section menu + each page's filters in the same bar (Top: list, period, year, custom range, rank by; Patterns / Year: year; Compare: by year/month). **Pins + folders** (Rotor only, no caps): pin anything (incl. Liked Songs, folders, YouTube/SoundCloud collections in their own space), drag to reorder (handle on the laptop, long-press on the iPhone, arrow keys), folders one level deep, a playlist in one folder, delete moves contents back. **Manage mode**: multi-select, pin/unpin, move to folder; extend/keep/delete for Custom 🎧 only, through the existing guarded API. |
| Migration | `0034_library_organiser.sql` (additive; 0031–0033 are taken by #99). KBs. |
| Spotify | Zero writes from organising (E2E V091-10, vitest: the organiser module has no Spotify import). |

## Timeline view

```
R0 ──► R1 (remote + daily pick) ──► R2 (playlists, rules) ──► R3 (stats parity, Streamlit read-only) ──► R4 (Elsewhere) ──► R6 (Wrapped) ──► R7 (Release radar) ──► v1.0 retire Streamlit
~1h     ~9h                          ~6h                       ~10h                                       ~5h                ~8h             ~8h                    ~1.5h
                                                                                                           └──► [R5 mixed, optional, nothing depends on it]
```

## Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Spotify enforces the postponed endpoint removals on existing Development Mode apps** (batch `GET /tracks`, non-owned playlist items, `/users/{id}/playlists`, artist top tracks …) | Medium (announced, only postponed) | Cron enrichment and the missed-new-tracks sweep degrade. Rotation loses followed-playlist previews (already designed out) | Hub uses only the restricted set. Port `lib/track_metadata.py` to single `GET /tracks/{id}` with backoff *before* enforcement. Watch the [changelog](https://developer.spotify.com/documentation/web-api/references/changes/july-2026) monthly |
| 2 | **Spotify tightens Development Mode further** (player endpoints restricted, lower quota, Premium tier changes) | Low–medium | Remote control (the core) breaks | Keep the hub useful without playback: stats, rules and the playlist manager don't need the player. Open-in-Spotify deep links as a fallback for every Play button |
| 3 | **Policy enforcement on III.5 / III.7 / III.11** (YouTube/SoundCloud integration, look-alike UI) → Client ID or developer account revoked | Low for a 1-user app | **Critical**: also kills the ~200 managed playlists the crons maintain | Compliant default (separate Elsewhere space, no mixed queue, own identity, attribution). Mixed sessions only behind explicit opt-in (Q1, Q3). Never publish or share the app |
| 4 | **Refresh-token 6-month expiry** surprises again | High (certain, every 6 months) | All Spotify crons and the hub stop | Token store with authorization date, countdown, push at 14 / 3 days, one-tap Reconnect (option A covers the crons too) |
| 5 | Shared per-account quota exhausted by polling + crons | Medium | 429 `QUOTA_EXCEEDED`, slower crons | Adaptive polling, zero polling when hidden, SDK events on the laptop, budget measured in the R1 spike, banner + back-off |
| 6 | **GitHub disables crons after 60 days without a push** | High until R0 | Silent data loss (recently-played only keeps 50 tracks) | R0 fix. Hub Data health shows last push + auto-disable date |
| 7 | iOS WebKit audio/PWA regressions | Medium | Only affects in-app playback (YouTube/SoundCloud, SDK on iPhone) | iPhone stays a remote for Spotify. Elsewhere playback is documented as foreground-only |
| 8 | Supabase free tier: 500 MB cap (≈ 255 MB used) or project pause | Medium (cap), low (pause, crons keep it awake) | Writes fail | Rollups < 30 MB. Monitor size in Data health. `spotify_plays` is 163 MB, so consider archiving `scrobbles` (38 MB, last.fm era) if needed |
| 9 | Secret leakage in a public repo | Low | Account takeover | Only `.env.example` files committed. Client secret, refresh tokens and DB URL in Vercel/GitHub secrets. Tokens encrypted at rest. CI grep for secrets in the client build (R1 smoke 7) |
| 10 | Two writers (Streamlit + Rotor) during migration | Low | Confusing state | Single-row idempotent writes. Streamlit write buttons removed in R3 |
| 11 | YouTube/SoundCloud embed rules change (ads, embed bans, widget API) | Medium | Elsewhere items stop playing | Elsewhere is isolated and optional. Embeddability checks at import |
| 12 | Scope creep (the feature spec has ~60 stats ideas) | High | Releases balloon | Parity first (R3 = what Streamlit has *now*). New stats only after v1.0 |

## Open questions (answers change the design)

1. **YouTube/SoundCloud placement:** keep them in a separate "Elsewhere" space with only a link card on Home (compliant, recommended), or put YouTube/SoundCloud shelves on Home next to Spotify as in your original vision, accepting the policy risk to your developer account (and with it the crons)?
2. **Spotify attribution:** may the attribution slot carry the official Spotify logo from Spotify's brand resources (licensed use, which the Design Guidelines require), or do you want to stay text-only and accept that deviation from the guidelines?
3. **Mixed sessions:** build R5 at all (laptop-only, opt-in, in conflict with Spotify policy III.5/III.7), or drop it and keep Spotify and Elsewhere strictly separate?
4. **Cron token:** option A (crons read the refresh token from the DB, so one Reconnect in Rotor fixes everything, at the cost of a small `lib/spotify.py` change) or option B (crons keep their GitHub secret and Rotor only reminds you)?
5. **Generated daily pick playback:** write it into one managed playlist `Daily pick · Auto 🤖🔄` (stable Spotify context, visible in the Spotify app; recommended) or play it as a bare track list with no playlist write? And what length should a pick have (e.g. 60–90 minutes)?
6. **Rotation pool:** which existing playlists may become the daily pick? Your own unmanaged playlists only, plus followed playlists (play-only), plus old snapshots (e.g. *Top 25 · March 2021*)? Any to exclude (e.g. *Recently Added Tracks*)?
7. **"This laptop":** do you want Rotor itself to be a playback device on the laptop (Web Playback SDK, needs extra scopes and media-key handling), or is the laptop purely a remote as well (Spotify desktop app as the speaker)?
8. **UI language:** English (as in the prototype) or Dutch, like the rule texts in `lib/playlists.py`?
9. **SoundCloud:** do you have (or want) SoundCloud Artist Pro? With it, Rotor can import your likes via the API. Without it, only pasted set/track URLs via widget + oEmbed.
10. **Streamlit at v1.0:** delete the Streamlit Cloud app entirely, or keep it frozen as a read-only fallback?
