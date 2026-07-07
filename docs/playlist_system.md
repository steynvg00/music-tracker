---
title: Playlist System — Complete Audit + Documentation
tags: [music-tracker, playlists, audit, documentation]
date: 2026-07-06
status: draft
cross-references: [track_badge_audit.md, artist_badge_workshop.md]
---

> **Living document.** Browsable, not linear. Jump via the headers. All live figures are
> production data pulled **2026-07-07** against `spotify_plays` / `playlist_settings` /
> `custom_playlists` / `playlist_rank_history` (413,993 plays · 29,309 distinct tracks · data
> span 2017-02-28 → 2026-07-07 · 5,315 liked songs). Cross-refs to the two companion reports are
> marked inline: [[track_badge_audit]] and [[artist_badge_workshop]].

# Executive summary

The system manages **219 auto-playlists** today (verified against `playlist_settings`, which
holds exactly 219 rows): **52 updating** (`🤖🔄`) and **167 frozen snapshots** (`🤖📸`), plus a
**user-generated custom** tier (`🎧`) that is **empty right now** (0 active). The machinery is
**healthy and internally consistent** — the registered-playlist count reconciles to the source
code line-for-line (10 static + 42 dynamic updating + 167 snapshot = 219), snapshots have been
fully backfilled, and every playlist carries the default order preference (no drift). Two
structural observations dominate: (1) **all 52 updating playlists refresh on a single weekly
Monday 06:00 UTC cron**, while snapshots are created by a *separate* daily 05:00 cron — so
calendar-boundary playlists (this-year / all-time Top 100, rolling monthly #1) can lag reality
by up to 6 days; and (2) **the rank-history feed that powers the digest's ↑/↓ arrows is only ~3
snapshots deep** (first row 2026-07-03), so trend arrows are essentially cold-started.

**Top 3 recommended changes** (analysis + the user's open tuning requests, reconciled):

1. **Split the refresh cadences the user already asked for.** Move `Top 100 this year` /
   `Top 100 all-time` to a **monthly 1st-of-month** refresh and `Forgotten favorites` to the
   **15th**, and give `Missed new tracks` a **daily** cadence with a release-age delay + 2-month
   expiry. This is the single biggest behavioural change and needs cron/scheduling work, not just
   constants.
2. **Rename `Top 50 last 30 days` → `Top 30 last 30 days`** (user request) — 5 positions above the
   frozen `Top 25 · Month` snapshot, so risers/fallers stay visible. Alongside it, **keep
   `My Monthly #1 🔄` as the live current-month leader** and **add a new `My Monthly #1 📸`**
   historical chain on the 1st (backfillable to 112 tracks — see finalized tuning).
3. **Turn badge signals into playlists.** Nothing today consumes `badge_events`. The clearest
   wins: a **"Slow burns"** playlist from `late_bloomer` ([[track_badge_audit]]) and a
   **"Dynasty"** playlist from the artist `multi_top`/dynasty concept ([[artist_badge_workshop]]).

Nothing below is invented for its own sake — where a subset is already well-covered or a request
has a hidden cost, it is flagged rather than rubber-stamped.

---

# Playlist inventory

**Kinds & name suffixes** (from `lib/playlists.py`):

| Kind | Emoji | Name suffix | Description boilerplate | Editable by hand? |
|---|---|---|---|---|
| updating | `🤖🔄` | ` · Auto 🤖🔄` | "Manual edits will be overwritten on the next refresh." | No — overwritten weekly |
| snapshot | `🤖📸` | ` · Auto 🤖📸` | "This playlist is frozen and will not be updated." | Frozen after creation |
| custom | `🎧` | ` · Custom 🎧` | "Auto-delete on … / Permanent" | Yes — user-owned |

**Grand totals (live):**

| Bucket | Count | Source of truth |
|---|---|---|
| Updating (`🤖🔄`) | **52** | `get_managed_playlists()` minus snapshots |
| Snapshot (`🤖📸`) | **167** | `get_snapshot_definitions()` |
| Custom (`🎧`) | **0** active | `custom_playlists` table |
| **Total managed** | **219** | `playlist_settings` row count ✅ (reconciles exactly) |

## Static playlists (`STATIC_PLAYLISTS` constant)

Ten hard-coded definitions. The 7 threshold tiers are cumulative "at least N plays" (except the
`20-49` band); the 3 Top tiers are windowed rankings.

| # | Name pattern | Type | Kind | Criteria | Limit | Refresh | Live count |
|---|---|---|---|---|---|---|---|
| 1 | `20-49 plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ∈ [20,49] | 10000 | weekly | **2,971** |
| 2 | `50+ plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ≥ 50 | 10000 | weekly | **2,703** |
| 3 | `100+ plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ≥ 100 | 10000 | weekly | **604** |
| 4 | `200+ plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ≥ 200 | 10000 | weekly | **124** |
| 5 | `300+ plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ≥ 300 | 10000 | weekly | **60** |
| 6 | `400+ plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ≥ 400 | 10000 | weekly | **34** |
| 7 | `500+ plays · Auto 🤖🔄` | updating | 🤖🔄 | plays ≥ 500 | 10000 | weekly | **20** |
| 8 | `Top 50 last 30 days · Auto 🤖🔄` | updating | 🤖🔄 | top-N by plays in trailing 30d | 50 | weekly | **50** |
| 9 | `Top 100 this year · Auto 🤖🔄` | updating | 🤖🔄 | top-N by plays in current local year | 100 | weekly | **100** |
| 10 | `Top 100 all-time · Auto 🤖🔄` | updating | 🤖🔄 | top-N by plays all-time | 100 | weekly | **100** |

The threshold-tier counts are the exact play-milestone populations analysed in
[[track_badge_audit]] (2,703 / 604 / 124 / 60 / 34 / 20 for the 50→500 tiers) — the playlists and
the `plays_*` badges are two surfaces on the same underlying distribution.

## Dynamic playlists — updating

Rebuilt every weekly run from the current DB state. **42 playlists** across 6 families.

### Family: `{year} · Discovered` — 11 playlists
Liked tracks whose *first play* fell in that year ("Undefined" = already in library at data
start, first play within 30 days of 2017-02-28). Ordered by first-play date ASC.

| Bucket | Live count | Bucket | Live count |
|---|---|---|---|
| Undefined | 395 | 2022 | 452 |
| 2017 | 913 | 2023 | 385 |
| 2018 | 700 | 2024 | 368 |
| 2019 | 526 | 2025 | 443 |
| 2020 | 523 | 2026 (partial) | 88 |
| 2021 | 510 | | |

### Family: `{year} · Released` — 15 playlists
Liked tracks by `track_metadata.release_year`. `< 2013` collapses into one `Pre-2013` bucket;
future-dated excluded. Ordered by release date ASC within the bucket.

| Bucket | Live | Bucket | Live | Bucket | Live |
|---|---|---|---|---|---|
| 2026 | 70 | 2021 | 470 | 2016 | 281 |
| 2025 | 395 | 2020 | 530 | 2015 | 223 |
| 2024 | 369 | 2019 | 525 | 2014 | 178 |
| 2023 | 383 | 2018 | 634 | 2013 | 99 |
| 2022 | 444 | 2017 | 589 | Pre-2013 | 124 |

### Family: `My {Month} #1` — 12 playlists
One playlist per calendar month, holding *that month's #1 track across every year*, ordered year
ASC. (E.g. `My March #1` = the March top track of 2017, 2018, … 2026.) 9–10 tracks each.

### `My Monthly #1` — 1 playlist (rolling)
One track per (year, month) the user had plays in, oldest-first, growing by one each month.
**Live: 113 tracks.** ⚠️ Named one word apart from the `My {Month} #1` family — see naming check.
**User has flagged this one for removal** (see User-requested tuning).

### `Forgotten favorites` — 1 playlist
Liked tracks with ≥50 plays not played in the last 365 days, ordered by play count DESC.
**Live: 388 tracks.** Top of the list: *Dusk Till Dawn* — Rebelion (689), *I Wasted All Of My
Time* — Phuture Noize (259), *The Game Changer* — Sub Zero Project (257).

### Family: `Missed new tracks · {popular|other} artists` — 2 playlists
Unplayed releases from the last **14 days** by followed artists, ranked by composite popularity.
`popular` = top 20 followed artists; `other` = ranks 21–1000. Counts are Spotify-live (depend on
the `/me/following` fetch) and were **not** materialised in this DB-only pass — flagged, not
guessed. Both are on the user's tuning list (daily cadence, delay, expiry, top-20→50).

## Dynamic playlists — snapshot

Created once by the **daily 05:00 create-snapshots cron** the morning a period ends, then frozen.
**167 playlists** across 4 families. Not touched by the weekly cron (explicitly filtered out).

| Family | Name pattern | Limit | Live count | Trigger |
|---|---|---|---|---|
| Monthly | `Top 25 · {Month} {YYYY} · Auto 🤖📸` | 25 | **112** | month-end |
| Seasonal | `Top 50 · {Season} {YYYY} · Auto 🤖📸` | 50 | **37** | astronomical season-end |
| Yearly | `Top 100 · {YYYY} · Auto 🤖📸` | 100 | **9** | year-end |
| All-time-to-date | `Top 100 · All-Time · {YYYY} · Auto 🤖📸` | 100 | **9** | year-end |
| Decade | `Top 100 · {YYYY}s · Auto 🤖📸` | 100 | **0** | next: 2030 |

Seasons use NL astronomical boundaries (Winter named by end-year). All-time-to-date snapshots
freeze the all-time top-100 *as of Dec 31 of year Y* — a moving canon captured yearly.

## Custom (user-generated)

Built on demand from the dashboard filter form (`temporary_playlists.py`); TTL-based
(default expiry set by the user, else permanent). Swept daily at 04:00 UTC once `expires_at`
passes. **Live: 0 active, 0 expired-pending, 0 permanent** — the custom tier is currently unused.
Schema (`custom_playlists`): `playlist_id, name, created_at, expires_at, track_count,
filters_summary`.

---

# Detailed playlist profiles

Full profiles for the 15 highest-value playlists/families. Each: criteria in prose + the actual
SQL shape, refresh trigger, data dependencies, live sample, retention notes.

## Threshold tiers (`N+ plays`, `20-49 plays`)

- **Criteria (prose):** every track you've played at least N times, ranked by play count DESC.
  The `20-49` tier is a *band* (the "still figuring out" tier); 50+…500+ are open-ended `≥N`.
- **SQL:** `SELECT track_uri FROM spotify_plays WHERE track_uri IS NOT NULL GROUP BY track_uri
  HAVING COUNT(*) >= N ORDER BY COUNT(*) DESC` (band uses `BETWEEN 20 AND 49`).
- **Trigger:** weekly Mon 06:00 UTC. **Deps:** `spotify_plays` only.
- **Sample (50+):** *The Ultimate* — D-Sturb (931) · *You Are My Storm* — Solstice (882) ·
  *Extortionist* — D-Sturb (814).
- **Retention:** membership is a pure high-water mark — tracks only ever climb tiers, never leave
  (except the `20-49` band, which empties upward into `50+`). Nearly static week-to-week; the
  feeder into `50+` is fat (852 tracks in the 40–49 "almost" band per [[track_badge_audit]]).

## `Top 50 last 30 days`

- **Criteria:** your 50 most-played tracks in the trailing 30 days (rolling window, not calendar
  month). This is the "what am I on right now" list.
- **SQL:** `… WHERE played_at >= NOW() - INTERVAL '30 days' GROUP BY track_uri ORDER BY COUNT(*)
  DESC LIMIT 50`.
- **Trigger:** weekly. **Deps:** `spotify_plays.played_at`. **Rank-tracked:** ✅ (writes
  `playlist_rank_history`; digest renders ↑/↓/★NEW). **Digest count scope:** last-30-day plays.
- **Sample:** *Messing With The Herd* — Noxiouz (40) · *The Definition* — Radical Redemption (35)
  · *BODY MOVE* — Hard Driver (27).
- **Retention/overlap:** highest churn of all Top lists. **19 of its 50 tracks appear in neither
  the this-year nor the all-time Top 100** — i.e. 38% are genuine fresh movers unique to the
  30-day window (see overlap matrix). This is exactly why the user wants it 5 slots deeper than
  the `Top 25 · Month` snapshot.

## `Top 100 this year`

- **Criteria:** your 100 most-played tracks in the current local (Europe/Amsterdam) calendar year.
- **SQL:** `… WHERE EXTRACT(YEAR FROM played_at AT TZ 'Europe/Amsterdam') = EXTRACT(YEAR FROM
  NOW() …) GROUP BY track_uri ORDER BY COUNT(*) DESC LIMIT 100`.
- **Trigger:** weekly (**user wants → monthly 1st**). **Rank-tracked:** ✅. **Digest scope:**
  this-year plays.
- **Sample:** *You Are My Storm* — Solstice (882) · *PUMP THE MUSIC* — Hard Driver (280) ·
  *Never Coming Down* — Sub Zero Project (103).
- **Retention:** resets each Jan 1 (the window moves), so it churns heavily in Q1 and stabilises
  toward year-end. Only **4 of its 100 tracks** also sit in the all-time Top 100 — this year's
  taste has diverged sharply from the all-time canon.

## `Top 100 all-time`

- **Criteria:** your 100 most-played tracks across all history.
- **SQL:** all-time `GROUP BY track_uri ORDER BY COUNT(*) DESC LIMIT 100`.
- **Trigger:** weekly (**user wants → monthly 1st**). **Rank-tracked:** ✅. **Digest scope:**
  all-time.
- **Sample:** *The Ultimate* — D-Sturb (931) · *You Are My Storm* — Solstice (882) ·
  *Extortionist* — D-Sturb (814).
- **Retention:** the most stable Top list — the canon barely moves week-to-week. This is the exact
  universe the artist **Dynasty** badge reads (≥3 tracks here → 7–10 artists, [[artist_badge_workshop]]);
  D-Sturb alone owns ~34 of the 100.

## `Forgotten favorites`

- **Criteria:** liked tracks with ≥50 plays whose *last* play is older than 365 days —
  re-discovery candidates.
- **SQL:** `WITH play_stats AS (… COUNT(*) plays, MAX(played_at) last_played …) SELECT ps.track_uri
  FROM play_stats ps JOIN liked_songs ls USING(track_uri) WHERE ps.plays >= 50 AND
  ps.last_played_at < NOW() - make_interval(days => 365) ORDER BY ps.plays DESC`.
- **Trigger:** weekly (**user wants → 15th of month**, window → 730 days).
- **Deps:** `spotify_plays` + `liked_songs`. **Live: 388.** At the proposed **730-day** window it
  shrinks to **225** (545-day midpoint = 266) — a leaner, more genuinely "forgotten" set.
- **Sample:** *Dusk Till Dawn* — Rebelion (689 plays, dormant) · *I Wasted All Of My Time* —
  Phuture Noize (259) · *The Game Changer* — Sub Zero Project (257).

## `My {Month} #1` (family of 12)

- **Criteria:** for calendar month M, the #1 track of that month in every year, ordered year ASC.
  Tie-break: earliest first-play wins (deterministic).
- **SQL:** `ROW_NUMBER() OVER (PARTITION BY yr, mo ORDER BY plays DESC, first_play ASC) = 1`,
  filtered to `mo = M`.
- **Trigger:** weekly. **Deps:** `spotify_plays`. 9–10 tracks each.

## `My Monthly #1` (rolling)

- **Criteria:** every (year, month)'s #1 track, oldest-first — a chronological "song of each
  month" scroll. Grows by one entry monthly. **Live: 113.**
- **Trigger:** weekly. Shares the `_monthly_top_one_per_month` query with the family above.
- **Status (finalized):** **kept** and re-coupled to a **monthly 1st-of-month** refresh (request
  #7), serving as the *live* counterpart to the new `My Monthly #1 📸` historical chain (request
  #6). Whether the `🔄` should hold one live track or the full rolling series is Design Question 2.

## `Missed new tracks · popular / other artists`

- **Criteria:** for each followed artist (ranked by composite popularity), fetch releases from the
  last 14 days via the Spotify API and keep the tracks you haven't played. `popular` = top 20
  ranked artists; `other` = ranks 21–1000. Dedup; release-date DESC.
- **Trigger:** weekly (**user wants → daily**). **Deps:** Spotify `/me/following` +
  `/artists/{id}/albums` + `spotify_plays` (played-set). **Not** materialisable in a DB-only pass.
- **Tuning open:** daily cadence, N-day release-age delay before inclusion, 2-month post-release
  expiry, and top-20 → top-50 (see tuning table).

## Snapshot families (`Top 25 · Month` / `Top 50 · Season` / `Top 100 · Year` / `· All-Time · Year`)

- **Criteria:** frozen top-N by plays within a completed period. Month = 25, season = 50, year =
  100, all-time-to-date = top-100 considering only plays through Dec 31 of year Y.
- **SQL:** `_ranked_with_plays()` — `… WHERE {period predicate} GROUP BY track_uri ORDER BY
  COUNT(*) DESC, MIN(played_at) ASC LIMIT {limit}`.
- **Trigger:** daily 05:00 create-snapshots cron detects the period-end (yesterday vs today) and
  creates exactly that period's snapshot; also awards the `top_1st_{kind}` badge to the #1 and
  sends a snapshot mail. **Deps:** `spotify_plays`, `lib/seasons` (astronomical boundaries),
  `badge_events` (idempotency).
- **Retention:** by design, none — frozen forever. These are the historical record; the
  `top_1st_month/season/year` badge families in [[track_badge_audit]] are minted from exactly
  these snapshots (112 / 37 / 9 filled periods ↔ 112 / 37 / 9 badge windows).

---

# Cross-cutting analysis

## Track overlap between Top playlists

Live intersection sizes among the three rank-tracked Top updating lists:

| | Top 50 / 30d | Top 100 / year | Top 100 / all-time |
|---|---|---|---|
| **Top 50 / 30d** (50) | — | 31 | 1 |
| **Top 100 / year** (100) | 31 | — | 4 |
| **Top 100 / all-time** (100) | 1 | 4 | — |
| **In all three** | | | **1** |

**Reading it:**
- **Only 1 track is in all three** — the near-universal favourite of the moment *and* the year
  *and* all-time. Recognition overlap is minimal, so the three lists are doing genuinely different
  jobs (good — no redundant Top list).
- **31/50 of the 30-day list is also in this-year** (recent listening drives the year), but **only
  1/50 reaches all-time** — the current rotation is almost entirely *not* all-time canon.
- **this-year ∩ all-time = 4** — this year's heavy rotation has diverged sharply from the
  historical top 100. That's a *coverage gap* (below): nothing captures "tracks breaking into the
  all-time canon this year."
- Threshold tiers overlap by strict nesting (500+ ⊂ 400+ ⊂ … ⊂ 50+); `Forgotten favorites` ⊂
  `50+ plays` by construction (both require ≥50 plays).

## Coverage gaps

Useful subsets **not** covered by any current playlist:

| Gap | Why it matters | Cheapest source |
|---|---|---|
| **Live current-calendar-month top** | `Top 25 · Month` only exists *after* the month ends (frozen); the 30-day rolling window ≠ calendar month | `query_top_in_month(current)` as an updating playlist |
| **Risers into the all-time canon** | this-year ∩ all-time = 4; nothing surfaces tracks *newly entering* the all-time Top 100 | diff all-time Top 100 vs last snapshot |
| **Liked-but-never-played** | `Missed new tracks` only covers *followed-artist releases*, not your own unplayed likes | `liked_songs` minus `spotify_plays` |
| **Slow burns / late bloomers** | `late_bloomer` badge exists (15 tracks) but no playlist surfaces them | `badge_events` (see recommendations) |
| **Dynasty / multi-track artists** | artist dominance is computed for badges but never turned into a listenable playlist | all-time Top 100 grouped by artist |
| **Sub-50-play re-discovery** | `Forgotten favorites` floors at 50 plays; dormant 20–49 tracks get nothing | lower the FF floor or add a tier |

## Naming consistency check

| Convention | Where it holds | Where it breaks |
|---|---|---|
| ` · ` separator in name | all snapshots (`Top 100 · 2025`) | updating Top lists omit it (`Top 100 this year`, not `Top 100 · This year`) |
| Kind emoji in suffix | all three kinds consistent (`🤖🔄`/`🤖📸`/`🎧`) | — |
| Window phrasing | — | mix of `last 30 days` / `this year` / `all-time` (three different idioms for the same "window" slot) |
| `#1` playlists | — | ⚠️ **`My Monthly #1` vs `My {Month} #1`** differ by one word and one is a rolling scroll, the other a 12-playlist family — genuinely confusable |
| Threshold naming | `N+ plays` + one `20-49 plays` band | consistent |

**One real risk (now sharper post-finalization):** the finalized plan keeps `My Monthly #1 🔄`
*and* adds `My Monthly #1 📸` (requests #6/#7), so **three** near-identical names will coexist:
`My Monthly #1 🔄` (live current-month leader), `My Monthly #1 📸` (historical chain), and the
12-playlist `My {Month} #1` family. Only the emoji suffix distinguishes the first two. Strongly
recommend renaming for legibility, e.g. `Monthly #1 — live 🔄` / `Monthly #1 — archive 📸`.

## Refresh timing map

```
UTC   Job                                 Cadence          Touches
────  ──────────────────────────────────  ───────────────  ─────────────────────────────
:00/:30 ingest_spotify_recent            every 30 min     spotify_plays (data source)
03:00 sync_liked_songs                    daily            liked_songs
03:30 enrich_track_metadata               daily            track_metadata
03:50 compute_track_popularity            daily            track_popularity_scores
03:55 compute_artist_popularity           daily            artist_popularity_scores
04:00 sweep_expired_custom_playlists       daily            custom_playlists (🎧 deletes)
05:00 create_snapshots                    daily            NEW 🤖📸 on period-end + badges
06:00 update_managed_playlists  (Mon only) WEEKLY           ALL 52 updating 🤖🔄
```

**Conflicts / lags to note:**
- **The 6-day calendar lag.** On the 1st of a month, `create_snapshots` (05:00 daily) freezes the
  new `Top 25 · Month`, but the *updating* `Top 100 this year` / `all-time` and the rolling
  `My Monthly #1` only refresh the following **Monday 06:00** — up to 6 days stale. The user's
  request to move the two Top 100s to a monthly-1st refresh **directly fixes this lag**.
- **No intra-cron conflict:** snapshots (05:00) and the weekly refresh (06:00 Mon) never write the
  same playlist — snapshots are filtered out of `get_managed_playlists`, and updating playlists
  are never frozen. Clean separation.
- **Rank-history is cold.** `playlist_rank_history` holds only **~3 snapshots** (750 rows across 3
  playlists; first 2026-07-03, last 2026-07-06), so digest ↑/↓ arrows have almost no baseline yet.
  Not a bug — just young. Arrows become meaningful after ~4–6 weekly runs.

---

# User-requested tuning

**Finalized 2026-07-07** — the user has confirmed the seven requests below. This supersedes the
earlier draft, most notably #6/#7: **`My Monthly #1 🔄` is now KEPT (not removed)** and a *new*
`My Monthly #1 📸` is added alongside it. Effort = code change size; Impact = live-count /
behaviour delta; Dependencies = migration / cron / logic / backfill needed.

| # | Playlist | Current criteria | Proposed criteria | User rationale | Effort | Impact | Dependencies |
|---|---|---|---|---|---|---|---|
| 1 | **Forgotten favorites** | ≥50 plays, untouched **365d**, weekly refresh | ≥50 plays, untouched **730d (2yr)**, refresh **15th of month** | 1yr too soon to be "forgotten"; monthly cadence | **Low** const + **Med** cron | 388 → **225** tracks (−42%) | new **15th-of-month cron** + `--only` subset filter; 1 constant flip (`_FORGOTTEN_FAVORITES_UNTOUCHED_DAYS` 365→730) |
| 2 | **Missed new tracks** (both) | releases last 14d, weekly, no delay, no expiry | **daily** refresh; **7-day delay** before adding an unplayed release; **expire 2 months after release date** | let a release settle; surface only genuinely-missed; auto-drop stale | **High** | membership timing model changes; see **Delay analysis** below (data supports **7d**) | **daily cron** for this family; **logic change** (age-gate + expiry); expiry can be **stateless** (derive from `track_metadata.release_date` each run) — no migration needed |
| 3 | **Missed new tracks · popular** | top **20** (`other` = 21–1000) | top **50** (`other` = 51–1000) | widen the "popular" net | **Low** | popular ≈ **2× throughput**; net-new to the *union* ≈ **0** (reclassifies band 21–50 from `other` → `popular`) — see **Saturation** below | 2 constants (`_MISSED_NEW_TRACKS_POPULAR_TOP_N` 20→50; `_MISSED_NEW_TRACKS_OTHER_RANGE` (21,1000)→(51,1000)); no migration |
| 4 | **Top 50 last 30 days** | limit **50**, name `Top 50 last 30 days` | limit **30**, name `Top 30 last 30 days` | 5 above the `Top 25 · Month` snapshot → risers/fallers visible | **Med** | list trims to 30; rename migrates the existing Spotify playlist (URL/followers kept) | `limit` 50→30; add old name to `legacy_names`; **update `RANK_TRACKED_PLAYLISTS`** substring; `_WINDOW_LAST_30_DAYS` unaffected (window unchanged) |
| 5 | **Top 100 this year / all-time** | weekly refresh | **monthly, 1st of month** | slow-moving canons; fixes 6-day calendar lag | **Med** | fewer refreshes; aligns to month boundary | **monthly cron** (Design Q1); ⚠️ **touches `playlist_rank_history`** — arrows go weekly→monthly (see dependency note below) |
| 6 | **My Monthly #1 📸** *(new)* | does not exist | each **1st**: append the **#1 of last month's `Top 25 · Month` snapshot**; grows 1/month | frozen historical chain of monthly winners | **Med** + **backfill** | +1 snapshot-style playlist; **backfill ≈ 112 tracks** (see backfill note) | new registry entry; **backfill** from `_monthly_top_one_per_month` / `top_1st_month` badges; append-only "snapshot" (semantic note below) |
| 7 | **My Monthly #1 🔄** *(kept)* | rolling updating playlist, **113 tracks**, weekly | **KEEP**; re-couple refresh to the **1st of month** (when the new `Top 25 · Month` drops); shows the **current month's leader (in-progress)** | live "who's winning this month" vs the 📸 historical chain | **Low–Med** | stays as the live counterpart to the 📸 archive | move off weekly cron → **1st-of-month cron** (shares #5/#6's monthly job); ⚠️ **scope ambiguity** — "one live track" vs "rolling series" (Design Q2) |

**Interlocks:**
- **#4** touches `RANK_TRACKED_PLAYLISTS` (matches the name as a substring) — the rename must land
  there or rank-history stops recording for the list. The digest scope-count window
  `_WINDOW_LAST_30_DAYS` is unaffected (the 30-day window itself doesn't change).
- **#5 ⊕ #6 ⊕ #7 share one monthly 1st-of-month cron.** All three want to fire on the 1st: the two
  Top 100s refresh, `My Monthly #1 📸` appends last month's winner, `My Monthly #1 🔄` resets to
  the new month. Sequencing matters — the 📸 must read the `Top 25 · Month` snapshot that
  `create_snapshots` (05:00) writes *that same morning*, so the monthly refresh must run **after**
  05:00.

## Delay tuning analysis (request #2)

**Question:** with a delay before an unplayed release is added, is **7 days** right, or does
**14 days** fit better — i.e. does a meaningful share of tracks get played on their own between
day 7 and day 14, so a 7-day delay surfaces them just before the user would reach them anyway?

**Method.** For every track the user *eventually played* that has a day-precision release date in
the tracking era (release_year ≥ 2017, not future-dated) — **21,262 tracks** — measure
`first_play_date − release_date`. 76 (0.4%) were first played *before* the release date
(pre-saves / precision noise) and are excluded; **21,186** were played on/after release.

**Distribution — days from release to first play:**

| Bucket | Tracks | % | Cumulative % played within N days |
|---|---|---|---|
| day 0 (release day) | 5,464 | 25.8% | ≤0d → **25.8%** |
| 1–3 days | 1,838 | 8.7% | ≤7d → **40.1%** |
| 4–7 days | 1,197 | 5.6% | ≤14d → **44.3%** |
| **8–14 days** | **890** | **4.2%** | ≤30d → 51.2% |
| 15–30 days | 1,460 | 6.9% | ≤60d → 58.6% |
| 31–60 days | 1,572 | 7.4% | ≤90d → 64.2% |
| 61–90 days | 1,177 | 5.6% | ≤180d → 74.2% |
| 91–365 days | 4,070 | 19.2% | ≤365d → 83.4% |
| >365 days | 3,518 | 16.6% | |

**Conclusion — 7 days is the better default.** The natural-play wave is heavily front-loaded:
**25.8% of eventually-played tracks are played on release day**, and **40.1% within 7 days**. The
"premature surfacing" band the user worried about — tracks played on their own in **days 8–14** —
is just **890 tracks = 4.2%** of eventually-played tracks (6.5% of the within-90-day population).
Extending the delay 7→14 days would suppress only that ~4pp of near-term noise, but at the cost of
**delaying every genuinely-missed track by an extra week** — and genuinely-missed tracks (played
day 15+, or never) are the entire point of the playlist. A 7-day delay already lets the dominant
day-0-through-7 wave play out. **Recommendation: ship 7 days** (the user's proposal); revisit to
14 only if the playlist feels noisy with "about to play anyway" tracks in practice.

## Saturation analysis (request #3 — top 20 → top 50)

**Caveat (flagged, not hidden):** the real feed ranks *followed* artists via the Spotify
`/me/following` + albums API and counts *unplayed* releases — neither is in Postgres, so an exact
"extra tracks/week" is not DB-derivable. Below is a **release-velocity proxy**: artists ranked by
**play count** (the same signal `rank_artists_by_plays` uses), counting distinct tracks *in the
library* by recent release date. It over-counts (includes played tracks) but is directionally
sound.

| Recent window | Band 1–20 releases | Band 21–50 releases (incremental) |
|---|---|---|
| since 2025-01-01 (~18 mo) | 302 | **294** |
| since 2026-01-01 (~6 mo) | 83 | **80** |

**Band 21–50 releases at essentially the same cadence as band 1–20** (294 vs 302; 80 vs 83) — the
tail-of-the-head is Da Tweekaz, Noisecontrollers, Brennan Heart, Frequencerz, Sefa, etc.: heavy,
frequent releasers. So expanding `popular` to top 50 roughly **doubles the `popular` playlist's
throughput** (~80 recent releases/6mo ≈ **3/week** proxy, unplayed subset smaller).

**Key insight — it's a reclassification, not new volume.** Those band-21–50 artists are *already
surfaced today* by `Missed new tracks · other` (range 21–1000). Moving them into `popular` means:
`popular` ≈ doubles, `other` **loses its most active head** and goes much quieter, and the
**union of the two playlists gains ~0 net-new tracks**. Saturation risk is therefore low — no
flood, just a shift of the busiest 30 artists from `other` into `popular`, which is exactly the
user's intent (see the more-important artists more prominently).

## `My Monthly #1 📸` — backfill consideration (request #6)

**Feasible, and the data already exists.** The 📸 chain is "one track per completed month = that
month's #1." Three equivalent sources, all already present:
- **`_monthly_top_one_per_month(conn)`** — the exact query the `🔄` playlist already uses; returns
  one `(year, month, top_uri)` per month. Excluding the in-progress month yields the completed
  series.
- **`top_1st_month` badge rows** — `badge_events` holds **112** of them (one per completed month
  with plays), each `entity_id` = that month's #1 track ([[track_badge_audit]]).
- The **112 existing `Top 25 · Month` snapshots** — their rank-1 track.

All three agree on **112 tracks** (the rolling `🔄` shows 113 because it *includes* the current
in-progress month; snapshots and badges cover completed months only). **Backfill volume = 112
tracks**, chronological oldest-first — one bulk `playlist_add_items` in ~2 batches. No migration,
no Spotify re-scan; recompute from `spotify_plays` is authoritative and matches how the snapshots
were built. **This is a quick, safe backfill** — the historical monthly-winner series can be
materialised in a single run.

**Semantic note.** A `📸` that *appends monthly* is not a classic frozen snapshot (created once,
never touched). It's really an **append-only updating** playlist wearing the `📸` badge. That's
fine — but it means it can't go through the `create_snapshots` "freeze once" path; it belongs on
the monthly refresh with an append (not replace) semantics, or a replace with the full
recomputed 112+ chain each month (simpler, idempotent, and what the existing `🔄` already does).
Recommend the **replace-with-full-chain** approach: identical to the current rolling query, just
scoped to completed months and named `📸`.

---

# Analytical recommendations (informed by badge audits)

The system computes rich per-track and per-artist badge signals in `badge_events` but **no
playlist consumes them**. A thin "badge-driven playlist" capability (query `badge_events` for a
`badge_type`, map `entity_id` → tracks, feed the existing updating-playlist machinery) unlocks all
of the below at once.

| Proposal | Definition | Source signal | Expected size | Label |
|---|---|---|---|---|
| **Slow burns** | tracks holding `late_bloomer` (>2yr gap, ≥30 plays in first 90d) | `badge_events.badge_type='late_bloomer'` | **15** today (~30–40 if loosened to >365d) | *informed by [[track_badge_audit]]* |
| **Dynasty** | all-time Top-100 tracks by artists with ≥3 tracks in that top 100 | artist multi-track dominance | **7–10 artists** / ~30–43 tracks (D-Sturb alone 34) | *informed by [[artist_badge_workshop]]* |
| **The comeback trail** | tracks holding `comeback` (dormant ≥6mo then ≥20 in a month) | `badge_events.badge_type='comeback'` | **20** | *informed by [[track_badge_audit]]* |
| **Rediscoveries** | tracks by artists matching the artist-`Rediscovery` pattern (Luner, Nico Moreno, Jyye…) | artist workshop's reframed comeback | ~17–37 artists | *informed by [[artist_badge_workshop]]* |
| **Multi-top hall** | tracks holding `multi_top` (in ≥10 managed playlists) | `badge_events.badge_type='multi_top'` | **23** | *informed by [[track_badge_audit]]* |
| **Unskippable / On Repeat / Obsession** | seed from the three *proposed* new badges once they exist | proposed badges | 96 / 953 / 46 | *informed by [[track_badge_audit]] (pending badge build)* |

**Sequencing note:** *Slow burns* and *Dynasty* are the two standout wins — they surface subsets
that the current 219 playlists provably miss (coverage-gap table), and both read from data that
already exists (`late_bloomer` badge rows; the all-time Top 100 the Dynasty badge already uses).
The three "pending badge" playlists (Unskippable/On Repeat/Obsession) depend on those badges being
greenlit first (Design Questions 6 in [[track_badge_audit]]).

The artist workshop's **"dynasty" concept explicitly maps to the track `multi_top` badge** — one
underlying phenomenon (a small set of artists/tracks saturating the tops) surfaced today only as
badges, never as something you can press play on.

---

# Design questions for user

1. **Refresh isolation mechanism.** Requests #1/#5 move individual playlists off the weekly cron
   onto their own dates (15th; 1st). Do you want (a) a new dated GitHub Actions cron + a
   `--only <playlist>` filter on `update_managed_playlists.py`, or (b) a single monthly cron that
   refreshes a *named subset*? (a) is more flexible; (b) is fewer moving parts.

2. **`My Monthly #1 🔄` scope, now that it's kept alongside the 📸.** The finalized plan keeps the
   `🔄` as the *live* counterpart to the `📸` archive. What should the `🔄` actually contain?
   Options: (a) **one track** — the current in-progress month's leader, reset each 1st (literal
   "who's winning this month"); (b) the **full rolling chain incl. the live month** (today's
   behaviour, 113 tracks), just refreshed monthly instead of weekly. The request text ("shows the
   current month's leader") points to (a), but that's a query change (`query_top_in_month(current,
   limit=1)`), whereas (b) is only a cadence change. Which did you mean? (The `📸` is settled:
   append the completed-month winner each 1st — see backfill note.)

3. **Monthly-refresh rank-history cadence (request #5 dependency).** Moving `Top 100 this year` /
   `all-time` to a monthly refresh means their `playlist_rank_history` snapshots — the source of
   the digest's ↑/↓/★NEW arrows — become **monthly**, while `Top 30 last 30 days` stays **weekly**.
   Two knock-ons: (i) in the *weekly* digest, the two Top 100s will show "no change" for ~3 of 4
   weeks then jump once a month; (ii) if they no longer refresh weekly, they drop out of the weekly
   digest email entirely (no `TRACKS_ADDED` event) — they'd need a **monthly** digest surface.
   Options: (a) accept mixed cadence + add a small monthly digest for the two Top 100s
   *(recommended — matches the monthly-1st snapshot rhythm)*; (b) keep all three rank-tracked lists
   weekly and only change the *playlist* refresh, decoupling rank-history from refresh (more code);
   (c) move `Top 30 last 30 days` to monthly too, so all three are consistent (loses the weekly
   trend signal the resize was meant to sharpen). This is the one genuine **dependency risk** in
   the seven requests.

4. **`Missed new tracks` expiry state.** A 2-month post-release expiry needs per-track "what's its
   release date" tracking. Store it in a new table, or derive release date live from
   `track_metadata` each run and filter? (Derive-live is stateless and simpler — **recommended**,
   since the delay analysis and expiry both key off `release_date` which is already 98.9%
   day-precise; a table only helps if you want to *display* "added on / expires on" like custom
   playlists do.)

5. **`Top 30` rename migration.** Renaming `Top 50 last 30 days` → `Top 30 last 30 days` will
   rename the existing Spotify playlist (via `legacy_names`), preserving its URL/followers. Confirm
   you want the same playlist trimmed to 30, not a new one alongside the old.

6. **Badge-driven playlists — build the generic capability, or one-offs?** The 6 recommendations
   all reduce to "playlist from a `badge_type`." Worth a small generic factory
   (`badge_playlist(badge_type, name)`), or hand-roll just *Slow burns* + *Dynasty* first?

---

# Change roadmap

Proposed sequencing of the seven finalized requests by cost and dependency.

### Quick wins (constants only — one small PR, no cron/migration)
- **#3** top-20 → top-50 for `Missed new tracks · popular` (two constants; + shift `other` to
  51–1000). Saturation is safe — it reclassifies band 21–50 from `other`, net-new ≈ 0.
- **#1 (constant half)** flip `_FORGOTTEN_FAVORITES_UNTOUCHED_DAYS` 365 → 730 (388 → 225 tracks).
  The 15th-of-month scheduling is the separate cron half below.
- **#4 (resize half)** `limit` 50 → 30 on `Top 50 last 30 days`. Bundle the rename with it.

### Medium (rename + one shared monthly cron)
- **#4 (rename half)** `Top 50 → Top 30 last 30 days`: add old name to `legacy_names`, **update the
  `RANK_TRACKED_PLAYLISTS` substring** (else rank-history stops recording). `_WINDOW_LAST_30_DAYS`
  needs no change.
- **The monthly 1st-of-month cron** (Design Q1) is the shared backbone for **#5 + #6 + #7** — it
  must run **after** the 05:00 `create_snapshots` so #6 can read that morning's `Top 25 · Month`:
  - **#5** refresh `Top 100 this year` / `all-time` — ⚠️ resolve the **rank-history cadence**
    dependency first (Design Q3: mixed weekly/monthly arrows + monthly digest surface).
  - **#7** re-couple `My Monthly #1 🔄` to this cron (drop from weekly) — pending the scope
    decision (Design Q2).
- **#1 (cron half)** a **15th-of-month** cron for `Forgotten favorites` — needs the same
  `--only`/subset filter on `update_managed_playlists.py` (Design Q1).

### Larger (new logic / backfill)
- **#2** `Missed new tracks`: **daily** cadence + **7-day** release-age delay (data-supported
  above) + **2-month** post-release expiry. Stateless via `track_metadata.release_date` (Design
  Q4) — biggest single behavioural change, but no migration.
- **#6** `My Monthly #1 📸`: new registry entry + **one-time backfill of 112 tracks** (recompute
  from `_monthly_top_one_per_month`, completed months only). Low-risk backfill; replace-with-full-
  chain each month thereafter (backfill note above).

### Nice-to-have (analytical, no user request behind them)
- **Badge-driven playlists** (Design Q6): generic `badge_playlist()` factory, then *Slow burns*
  ([[track_badge_audit]]) and *Dynasty* ([[artist_badge_workshop]]) as the first two instances.
- **Risers into the all-time canon** (diff all-time Top 100 vs the last all-time snapshot).
- Lower/second **Forgotten favorites** tier for dormant 20–49-play tracks.
- Resolve the `My Monthly #1 🔄` / `My Monthly #1 📸` / `My {Month} #1` **naming collision** once
  #6/#7 land — three near-identical names (see naming-consistency note).

---

*End of audit. Companion reports: [[track_badge_audit]] · [[artist_badge_workshop]]. All live
figures reproducible from `spotify_plays` / `playlist_settings` / `custom_playlists` /
`playlist_rank_history` as of 2026-07-07.*
