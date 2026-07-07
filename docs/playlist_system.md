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
   frozen `Top 25 · Month` snapshot, so risers/fallers stay visible. Then **retire the redundant
   `My Monthly #1 🔄`** and replace it with a **`My Monthly #1 📸` snapshot** on the 1st.
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
- **Status:** ⚠️ user-flagged **redundant** vs a deeper 30-day Top; slated for removal + replaced
  by a `📸` snapshot variant.

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

**One real risk:** the `My Monthly #1` / `My {Month} #1` collision. If the rolling one is removed
(user request) and a `📸` snapshot added, pick a clearly distinct name (e.g. `Monthly #1 archive`).

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

Open requests already voiced by the user, documented here (not overruled — the analysis above is
separate). Effort = code change size; Impact = live-count / behaviour delta.

| # | Playlist | Current criteria | Proposed criteria | User rationale | Effort | Impact |
|---|---|---|---|---|---|---|
| 1 | **Forgotten favorites** | ≥50 plays, untouched **365d**, weekly refresh | ≥50 plays, untouched **730d (2yr)**, refresh **15th of month** | 1yr too soon to be "forgotten"; monthly beat | **Low** const + **Med** cron isolation | 388 → **225** tracks; needs a dedicated 15th-of-month invocation |
| 2 | **Missed new tracks** (both) | releases last 14d, weekly, no delay, no expiry | **daily** refresh; **delay N days** (1–2 wk) before adding a release; tracks **expire 2 months** after release date | avoid adding day-0 noise; let a release settle; auto-drop stale | **High** (new cadence + delay + expiry logic + state) | changes membership timing model; needs per-track age tracking |
| 3 | **Missed new tracks · popular** | top **20** followed artists (`other` = 21–1000) | top **50** (`other` = 51–1000) | widen the "popular" net | **Low** (two constants) | more popular-artist releases surface; `other` shrinks at the head |
| 4 | **Top 50 last 30 days** | limit **50**, name `Top 50 last 30 days` | limit **30**, name `Top 30 last 30 days` | 5 above the `Top 25 · Month` snapshot → risers/fallers visible | **Med** (limit + rename + `legacy_names` + `RANK_TRACKED_PLAYLISTS` substring) | list trims to 30; rename must migrate the existing Spotify playlist |
| 5 | **Top 100 this year / all-time** | weekly refresh | **monthly, 1st of month** | weekly is overkill for slow-moving canons; fixes calendar lag | **Med** (cron isolation for 2 playlists) | fewer refreshes; aligns with month boundary |
| 6 | **My Monthly #1 🔄** | rolling updating playlist, 113 tracks | **remove** | redundant — `Top 30 last 30 days` shows trending | **Low** (drop from 2 registries; optionally unfollow) | -1 updating playlist |
| 7 | **My Monthly #1 📸** | does not exist | **add** — snapshot each 1st capturing the month's #1 | keep a frozen monthly-#1 record | **Med–High** (rolling snapshot contradicts "frozen" model — see design Q) | +1 snapshot family |

**Interlocks worth calling out:** #4 (rename) touches `RANK_TRACKED_PLAYLISTS` and the digest's
scope-count window `_WINDOW_LAST_30_DAYS` — both reference the `Top 50 last 30 days` name/window.
#6 + #7 are a pair: retire the `🔄`, introduce a `📸`. #7's "snapshot that grows monthly" is a
semantic tension with the frozen-snapshot contract (a true snapshot is created once and never
updated) — flagged as Design Question 2.

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

2. **`My Monthly #1 📸` semantics.** A snapshot is "created once, frozen forever." A monthly-#1
   record that *grows every month* isn't a snapshot — it's an updating playlist that only appends.
   Options: (a) keep it as an **append-only updating** playlist (really just the current
   `My Monthly #1` renamed — contradicts "remove it"); (b) create a **fresh frozen snapshot each
   month** (`My #1 · {Month} {YYYY} 📸`, one track each — proliferates playlists); (c) drop the
   `📸` idea and rely on the per-month `Top 25 · Month` snapshots (whose #1 already carries the
   `top_1st_month` badge). Which "frozen monthly #1" shape do you actually want?

3. **`Missed new tracks` expiry state.** A 2-month post-release expiry needs per-track "when did
   this enter the playlist / what's its release date" tracking. Store it in a new table, or derive
   release date live from `track_metadata` each run and filter? (Derive-live is stateless and
   simpler; a table lets you show "added on / expires on" like custom playlists do.)

4. **`Top 30` rename migration.** Renaming `Top 50 last 30 days` → `Top 30 last 30 days` will
   rename the existing Spotify playlist (via `legacy_names`), preserving its URL/followers. Confirm
   you want the same playlist trimmed to 30, not a new one alongside the old.

5. **Badge-driven playlists — build the generic capability, or one-offs?** The 6 recommendations
   all reduce to "playlist from a `badge_type`." Worth a small generic factory
   (`badge_playlist(badge_type, name)`), or hand-roll just *Slow burns* + *Dynasty* first?

---

# Change roadmap

Proposed sequencing by cost and dependency.

### Quick wins (constants only — one small PR)
- **#3** top-20 → top-50 for `Missed new tracks · popular` (+ shift `other` range to 51–1000).
- **#6** remove `My Monthly #1 🔄` from `get_managed_playlists` + `get_updating_definitions`.
- **#1 (partial)** flip the `_FORGOTTEN_FAVORITES_UNTOUCHED_DAYS` constant 365 → 730 (the 15th-of
  -month scheduling is a separate, larger change).

### Medium (rename / cron isolation)
- **#4** `Top 50 → Top 30 last 30 days`: change `limit`, add old name to `legacy_names`, update the
  `RANK_TRACKED_PLAYLISTS` substring and the `_WINDOW_LAST_30_DAYS` digest window reference.
- **#1 + #5** dated refresh crons (needs the mechanism from Design Q1): FF on the 15th, the two
  Top 100s on the 1st. Depends on a `--only`/subset filter in `update_managed_playlists.py`.
- **Coverage-gap quick fills:** a **live current-calendar-month Top 25** updating playlist
  (`query_top_in_month(current)`), and a **liked-but-never-played** playlist
  (`liked_songs` − `spotify_plays`).

### Larger (new logic / state)
- **#2** `Missed new tracks` daily cadence + release-age delay + 2-month expiry (Design Q3).
- **#7** the frozen `My Monthly #1 📸` (Design Q2 resolves the shape first).
- **Badge-driven playlists** (Design Q5): generic `badge_playlist()` factory, then *Slow burns*
  ([[track_badge_audit]]) and *Dynasty* ([[artist_badge_workshop]]) as the first two instances.

### Nice-to-have (analytical, no user request behind them)
- **Risers into the all-time canon** (diff all-time Top 100 vs the last all-time snapshot).
- Lower/second **Forgotten favorites** tier for dormant 20–49-play tracks.
- Resolve the `My Monthly #1` / `My {Month} #1` **naming collision** whichever way #6/#7 land.

---

*End of audit. Companion reports: [[track_badge_audit]] · [[artist_badge_workshop]]. All live
figures reproducible from `spotify_plays` / `playlist_settings` / `custom_playlists` /
`playlist_rank_history` as of 2026-07-07.*
