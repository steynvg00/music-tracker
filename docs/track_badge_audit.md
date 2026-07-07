---
title: Track Badge System — Retrospective Audit
tags: [music-tracker, badge-system, audit]
date: 2026-07-06
version: post-v0.70
status: draft
---

# Executive summary

The 22 track badge types (across 6 categories) are, on the whole, **well-calibrated against
9.4 years / 413,835 plays / 29,304 distinct tracks**. The play-milestone pyramid is textbook
at the bottom (`plays_50` captures the top 9.2% of the catalog; 75.6% of tracks have fewer
than 10 plays) and the rankings family shows a healthy, un-monopolised spread. But three
concrete problems surface from the data:

1. **`plays_300/400/500` are linearly spaced and shallow.** The bottom tiers shrink ~4.5–4.9×
   per step; the top three shrink only 2.1× / 1.8× / 1.7×. The 480–499 "almost" band is
   *empty* and the catalog max is 931 — the ceiling has been reached, so the top of the
   pyramid is a plateau, not a point.
2. **`late_bloomer` (15 rows) is both too rare and structurally gated.** The literal definition
   yields 19 tracks, but the "only evaluated at the plays_50 crossing" trigger silently drops
   4 genuine late bloomers that have 30–90 engaged plays but never reach 50 total. This is a
   correctness gap, not just a tuning choice.
3. **Streaks have a flat 5–9-year plateau** (785/676/476/545/588 tracks at exactly 5/6/7/8/9
   years) with **2,285 tracks sitting between the two badges unrecognised**, then a cliff at
   the 10-year data ceiling (500 tracks).

Top 3 recommended actions: **(a)** loosen `late_bloomer` to a >1-year gap and decouple it from
the plays_50 gate; **(b)** decide whether to add a single mid-streak tier (`streak_8_years`,
~1,633 tracks) for the flat middle; **(c)** leave the play-milestone thresholds as-is (a
retroactive re-tune churns history and mail semantics for marginal pyramid gain) but adopt
geometric spacing for any *future* tier. Everything else is green — no fake concerns invented.

All counts below are live `badge_events` / `spotify_plays` production figures (2026-07-06),
which match the v0.67.1 dry-run in `badge_definitions.md` within a few rows of post-dry-run
drift.

---

# Per-category audit

## Play milestones — health: 🟡 yellow (green bottom, shallow top)

**Current distribution** (`badge_events`, single-fire):

| Tier | Count | % of catalog | Shrink vs previous tier |
|---|---|---|---|
| plays_50  | 2703 | 9.22% | — |
| plays_100 | 604  | 2.06% | 4.47× |
| plays_200 | 124  | 0.42% | 4.87× |
| plays_300 | 60   | 0.20% | **2.07×** |
| plays_400 | 34   | 0.12% | **1.76×** |
| plays_500 | 20   | 0.068% | **1.70×** |

**Full play distribution** (all 29,304 played tracks): 1–9 plays → 22,160 (75.6%); 10–49 →
4,441 (15.2%); 50–99 → 2,099; 100–199 → 480; 200–299 → 64; 300–399 → 26; 400–499 → 14; 500+ →
20. Median plays/track = **2**, p90 = 47, p99 = 137, **max = 931**.

**Analysis.** The lower pyramid is exactly what you want: each of the first two steps culls
~78–79% of holders (4.47× and 4.87×). The problem is the **top three tiers use linear +100
spacing**, and with a hard data ceiling at 931 that produces a shallow tail — 60 → 34 → 20 is
barely a pyramid, it's a ramp. The near-threshold "almost" bands confirm the pipeline runs dry
at the top:

| Just-under band | Tracks waiting |
|---|---|
| 40–49 (→ plays_50)  | **852** |
| 90–99 (→ plays_100) | 149 |
| 180–199 (→ plays_200) | 41 |
| 280–299 (→ plays_300) | 8 |
| 380–399 (→ plays_400) | 4 |
| 480–499 (→ plays_500) | **0** |

852 tracks are within 10 plays of their first badge — a rich feeder for `plays_50`. By
contrast nothing is approaching `plays_500`. This is inherent to a single-listener 9-year
dataset, not a bug.

**Alternative-schema test** (cumulative "≥ threshold" counts, so you can read any schema off
one row):

| ≥50 | ≥75 | ≥100 | ≥150 | ≥200 | ≥250 | ≥300 | ≥400 | ≥500 | ≥750 | ≥1000 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2703 | 1172 | 604 | 242 | 124 | 88 | 60 | 34 | 20 | 4 | 0 |

- Current `50/100/200/300/400/500` → `2703/604/124/60/34/20`.
- A geometric-top variant `50/100/200/350/500` would give ~`2703/604/124/~45/20` — smoother,
  but the gain is marginal and `350` interpolates to only ~45.
- `50/100/250/500/1000` → `2703/604/88/20/0` — cleaner ratios but **loses a tier and 1000 is
  unreachable** (max 931).

**Recommendation: keep the thresholds.** A retroactive re-tune rewrites `badge_type` strings
(`plays_350`), invalidates historical mail semantics, and needs a migration + backfill — all
for a cosmetically smoother top that the data ceiling caps anyway. Document the 300/400/500
plateau as a known, benign artifact of a maxed-out dataset. **For any *future* tier, use
geometric spacing** — the next natural milestone is `plays_750` (currently 4 tracks), which
becomes meaningful only as the catalog deepens.

## Rankings — health: 🟢 green (populated tiers)

**Current distribution** (multi-fire, `context['window']` = period name):

| Badge | Instances | Distinct tracks | Periods with a #1 |
|---|---|---|---|
| top_1st_month  | 112 | 109 | 112 (all months filled) |
| top_1st_season | 37  | 37  | 37 |
| top_1st_year   | 9   | 9   | 9 |
| top_1st_alltime | 0 | 0 | — (never backfilled) |
| top_1st_decade  | 0 | 0 | — (next occurs 2030) |

**Analysis.** The spread is healthy — **almost no clustering**. Only one track has been #1 of
3 different months; exactly one other repeats (2 months); every other holder appears once.
Seasons and years show *zero* repeats. So the ranking badges are not monopolised by a handful
of mega-tracks — the "#1 of a period" honour rotates, which is the intended behaviour.

There is genuine **cross-kind overlap**: a small set of tracks are simultaneously #1 of a
month, that month's season, *and* that year (the top holder has 5 first-places across 3
kinds). That overlap is a latent opportunity (see "Triple Crown" under missing types).

**Gaps:** (1) `top_1st_alltime` and `top_1st_decade` are structurally 0 — an all-time #1
demonstrably exists, it just was never backfilled from an all-time snapshot. (2) No podium
(`top_2nd`/`top_3rd`) concept exists, so being #2 of a decade earns nothing.

**Recommendation:** backfill `top_1st_alltime` (one snapshot away from being real); treat the
podium question as a user decision (see Design Questions).

## Streaks — health: 🟡 yellow (flat middle, unrecognised volume)

**Current distribution:** `streak_5_years` = 3570, `streak_10_years` = 500 (ratio 7.14 : 1).

**Best-run-length histogram** (longest consecutive-year run per track):

| exactly 5 | 6 | 7 | 8 | 9 | 10 (ceiling) |
|---|---|---|---|---|---|
| 785 | 676 | 476 | 545 | 588 | 500 |

Cumulative: ≥5 = 3570, ≥6 = 2785, ≥7 = 2109, ≥8 = 1633, ≥10 = 500. **Max = 10** — the dataset
spans 2017–2026, so "10-year streak" literally means *played in every tracked year*.

**Analysis.** Unlike a normal geometric streak decay, this distribution is **nearly flat from
5 to 9** then cliffs at the 10-year ceiling. The reason is structural: over a 10-year window,
a track that survives 5 straight years usually keeps going. The consequence is **2,285 tracks
(exactly 6/7/8/9 years) live between the two badges with no recognition**, and the 7:1 gap
between the tiers is wide.

**Recommendation.** A single mid-tier is defensible on volume. The geometric midpoint of
3570 and 500 is √(3570·500) ≈ 1,336, which lands closest to **`streak_8_years` (≥8 = 1633)**.
`streak_7_years` (2109) is arguably too close to the 5-year tier. Caveat to surface: because
the 10-year value is a *data ceiling*, higher tiers (11, 12…) will appear automatically as
tracking continues — so the streak family is self-extending and the "flat middle" will
stretch over time. Whether to add a middle tier now or wait is a judgement call (Design
Questions).

## Daily intensity — health: 🟢 green

**Current distribution** (multi-fire per date):

| Badge | Instances | Distinct tracks |
|---|---|---|
| plays_20_in_day | 842 | 511 |
| plays_40_in_day | 286 | 212 |

Overlap: all 212 forty-earners are twenty-earners (clean cascade). Extremes: two tracks have
**10 separate ≥20-play days**; the single hottest day on record is **224 plays of one track
(2025-01-13)**.

**Analysis.** 20/40 is a clean 2.4 : 1 distinct-track ratio — a good two-step. A hypothetical
middle `plays_30_in_day` would sit neatly between (300 distinct / 443 instances). More
interesting: the data contains genuine *obsession* days the current ceiling ignores —
`≥60/day` = 119 tracks, `≥100/day` = 46 tracks.

**Recommendation:** the existing 20/40 spacing is fine; a `plays_30_in_day` middle tier is
optional granularity, not a need. The stronger opportunity is a **rare top tier** (`≥60` or
`≥100` in a day) — see "Obsession" under missing types.

## Release timing — health: 🟢 green for 3 of 4, 🔴 red for late_bloomer

Day-precision `release_date` coverage: **28,987 / 29,315 = 98.9%**.

| Badge | Count | Notes |
|---|---|---|
| played_on_day_one | 5464 | 18.6% of catalog, silent |
| day_one_fan | 266 | ≥20 plays on release day |
| release_week_fan | 330 | ≥50 plays in release week (days 0–7) |
| late_bloomer | 15 | >2yr gap + ≥30 plays in first 90d |

Conversions: `played_on_day_one → day_one_fan` = 266/5464 = **4.9%**; `→ release_week_fan` =
6.0%. Both reasonable — roughly 1 in 20 day-one listens becomes real day-one engagement.

**Threshold sensitivity:**

- `day_one_fan` (plays on release day): ≥10 → 566, ≥15 → 368, **≥20 → 269** (→ 266 after the
  ≥50-total gate), ≥25 → 211, ≥30 → 161. The current ≥20 sits on a healthy shoulder.
- `release_week_fan` (plays in week): ≥30 → 622, ≥40 → 441, **≥50 → 330**, ≥75 → 204. Current
  ≥50 is well-placed.
- `late_bloomer`: literal definition (gap >730d & ≥30-in-90d) = **19 tracks**, but production
  holds only **15** — the missing 4 are the ≥50-total-plays trigger gate silently excluding
  qualifying tracks. Loosening the gap to **>365 days** → 39 (pure) / ~30 (gated). Loosening
  engagement to ≥20-in-90d → 96 (at 2yr) / 201 (at 1yr).

**Analysis.** Three of the four are green — thresholds land on clean volumes and the
conversions make intuitive sense. `late_bloomer` is the outlier: at 15 rows (0.05%) it is the
rarest badge in the system, *and* it has a genuine correctness gap — a track that first plays
3 years post-release and racks up 40 plays in the next 90 days but never crosses 50 total will
**meet the definition yet never earn the badge**, because detection only runs at the plays_50
crossing.

**Recommendation:** (1) loosen the gap to **>365 days** (roughly doubles volume to a healthier
~30–40) and/or engagement to a lower bar; (2) **decouple `late_bloomer` from the plays_50
trigger** so the ≥50-total gate stops silently dropping qualifiers. This is the single
clearest evidence-based fix in the audit. Leave `day_one_fan` / `release_week_fan` alone.

## Behavioral — health: 🟡 yellow (rare; two tiers un-testable in pure SQL)

Current: `comeback` = 20 (multi-fire), `season_regular` = 13, `multi_top` = 23.

**`comeback` sensitivity** (dormancy months × min plays in comeback month), recomputed
directly from `spotify_plays`:

| Dormancy | Min plays | Instances |
|---|---|---|
| 6 mo | 20 | **20 (current)** |
| 6 mo | 10 | 64 |
| 3 mo | 20 | 35 |
| 3 mo | 10 | 134 |
| 12 mo | 20 | 5 |

**Analysis.** `comeback` at (6 mo, ≥20) yields 20 — rare, but "comeback" is *meant* to be a
prestige event, so rarity is defensible. Relaxing min-plays 20→10 triples it (64); relaxing
dormancy 6→3 mo nearly doubles it (35). `season_regular` (13) and `multi_top` (23) are also
rare-but-intentional.

**Limitation flagged (not skipped):** `season_regular` (≥2 vs ≥3 seasonal top-25) and
`multi_top` (≥8 vs ≥10 playlists) **cannot be tuned in pure SQL** — both recompute rankings
from `spotify_plays` through the `rank_period_tracks` / `_multi_top_universe` engine
(snapshots store no membership in Postgres, and season boundaries are astronomical). Producing
their sensitivity curves needs a Python spike against `lib/badges.py`, out of scope for a
read-only SQL audit. Current values (13, 23) are reported; their "if threshold were X" rows
are **TODO — engine required**.

**Recommendation:** keep `comeback` as a prestige badge; if more rewards are wanted, drop
dormancy to 4 mo or min-plays to 15 (see sensitivity table). Commission a follow-up spike to
produce `season_regular` / `multi_top` sensitivity before touching those.

---

# Threshold sensitivity analysis

Consolidated "if we move threshold X to Y, count goes from A to B" table. ✅ = computed from
production; ⚠️ = requires the ranking engine (not computed).

| Badge | Current threshold → count | Alternative → count |
|---|---|---|
| plays_300 | ≥300 → 60 | ≥250 → 88 · ≥350 → ~45 (interp) |
| plays_500 | ≥500 → 20 | ≥750 → 4 · ≥1000 → 0 (unreachable) |
| streak (middle) | — | ≥7 → 2109 · **≥8 → 1633** · ≥9 → 1088 |
| plays_N_in_day (middle) | 20→511 / 40→212 | **30 → 300** distinct |
| plays_N_in_day (top) | 40 → 212 | 60 → 119 · 100 → 46 |
| day_one_fan | ≥20/day → 266 | ≥15 → 368 · ≥25 → 211 |
| release_week_fan | ≥50/wk → 330 | ≥40 → 441 · ≥75 → 204 |
| late_bloomer gap | >730d → 15 (19 pure) | **>365d → ~30 (39 pure)** |
| late_bloomer engage | ≥30/90d → 19 | ≥20/90d → 96 |
| comeback dormancy | 6 mo → 20 | 3 mo → 35 · 12 mo → 5 |
| comeback min-plays | ≥20 → 20 | ≥10 → 64 |
| season_regular | ≥3 seasons → 13 | ≥2 → ⚠️ engine required |
| multi_top | ≥10 playlists → 23 | ≥8 → ⚠️ engine required |

---

# Missing badge types (proposals)

Five ideas tested against the data. **Three are strongly supported; two are weak for *this*
user and I recommend against them with the evidence, rather than inventing a fit.**

### 1. "Unskippable" (skip resistance) — 🟢 strong

- **Definition (SQL):** `≥100 total plays AND 0 plays with skipped = TRUE` → **96 tracks**.
  Softer variant `≥50 plays AND skip-rate ≤ 2%` → 1,106; `≥50 plays AND 0 skips` → 483.
- **Expected volume:** 96 (prestige) to 483 (accessible), depending on tier chosen.
- **Rationale:** skip data is present on 411,524 plays (7% overall skip rate). A track played
  100+ times *and never once skipped* is a strong, legible loyalty signal orthogonal to raw
  play count. Recommend the `≥100 & 0-skip` (96) prestige framing.
- **Multi-fire:** no. **Trigger:** ingest cron (recompute on batch tracks). **Context:**
  `{plays, skips}`.

### 2. "On Repeat" (loop sessions) — 🟢 strong

- **Definition (SQL):** a *loop session* = ≥5 consecutive plays of the same track with each
  gap < 30 min (gaps-and-islands over `played_at`). **953 tracks / 2,742 sessions** at ≥5;
  1,679 tracks at ≥3. Longest loop on record = **178 consecutive plays**.
- **Expected volume:** 953 distinct tracks (≥5). Multi-fire per session.
- **Rationale:** captures the "put it on and let it ride" behaviour that play totals blur.
  Distinct from `plays_20_in_day` (which counts a whole day, not a contiguous run).
- **Multi-fire:** yes (`window` = session-start date/id). **Trigger:** ingest cron.
  **Context:** `{session_len, started_at}`.

### 3. "Obsession" (single-day ultra-intensity) — 🟢 strong

- **Definition (SQL):** ≥100 plays of one track in one local day → **46 tracks / 56
  instances**; ≥60/day → 119 tracks. Effectively a 3rd daily-intensity tier above
  `plays_40_in_day`.
- **Expected volume:** 46 (≥100) or 119 (≥60). Multi-fire per date.
- **Rationale:** the data has real obsession days (peak 224 plays/day). The current ceiling
  (`plays_40_in_day`) leaves a 5.6×-larger extreme unrecognised.
- **Multi-fire:** yes (`window` = date). **Trigger:** ingest cron. **Context:** `{plays, day}`.

### 4. "Triple Crown" (rankings meta) — 🟢 strong, needs verification

- **Definition:** the same track is #1 of a calendar month **and** that month's season **and**
  that year. Cross-kind data shows a handful of tracks already hold #1 across all three kinds
  (top holder: 5 first-places over 3 kinds); exact same-period matches were not isolated in
  this pass.
- **Expected volume:** low single digits — a genuine "track of the era" honour.
- **Multi-fire:** yes (per year). **Trigger:** `create_snapshots.py` at year-end. **Context:**
  `{year, month, season}`. **Note:** exact count needs a same-period join — TODO before build.

### 5. "Night Owl" / "Globetrotter" — 🔴 weak for this user, recommend against

- **Night Owl** (majority of plays 23:00–02:59 local): only **2 tracks** clear ≥20 plays &
  >50% night; 16 at >40%. Overall night share is just **13.9%** — this listener is not
  night-clustered. A night badge would fire for almost no one. Skip.
- **Globetrotter** (≥N distinct platforms): ≥5 platforms → **5,520 tracks** — far too common
  (this user routinely spans devices), so it fails the "exclusive" bar. Skip, or only viable
  at an implausibly high N.

---

# Design questions for user

1. **Play-milestone thresholds — retune or freeze?** The 300/400/500 tail is shallow (shrink
   2.1×/1.8×/1.7×). Options: **(a)** freeze — accept the plateau as a maxed-dataset artifact
   *(recommended)*; **(b)** re-tune to `50/100/200/350/500` (migration + backfill + renamed
   badge strings); **(c)** freeze now, use geometric spacing (`750`, `1000`) only for future
   additions.

2. **Mid-streak tier — add `streak_8_years` (~1,633 tracks) now, or wait?** The 5–9 middle is
   flat and 2,285 tracks are unrecognised. Options: **(a)** add `streak_8_years` now; **(b)**
   wait — the 10-year ceiling lifts naturally as tracking continues, so higher tiers appear on
   their own; **(c)** add `streak_7_years` instead (2,109, closer to the 5-year tier).

3. **`late_bloomer` fix — how far to loosen?** Options: **(a)** gap >365d **and** decouple
   from the plays_50 gate → ~30–40 tracks, fixes the correctness gap *(recommended)*; **(b)**
   keep 2yr gap but only decouple the gate → ~19; **(c)** leave as-is (accept 15/0.05%).

4. **Rankings podium — add 2nd/3rd place badges?** Options: **(a)** no podium, keep #1-only;
   **(b)** add `top_2nd_*` / `top_3rd_*` for each period kind (triples the rankings family);
   **(c)** a single combined `podium_*` badge for "top-3 of a period".

5. **Backfill `top_1st_alltime`?** It is structurally 0 today but an all-time #1 exists.
   Options: **(a)** backfill from an all-time snapshot now; **(b)** leave until the all-time
   snapshot pipeline exists.

6. **Which missing badges to greenlight?** Recommended set: **Unskippable**, **On Repeat**,
   **Obsession**, **Triple Crown**. Options per badge: adopt / defer / drop. (Night Owl and
   Globetrotter are recommended *drop* on the evidence above.)

7. **`comeback` — keep prestige or broaden?** Options: **(a)** keep (6 mo, ≥20) = 20 badges;
   **(b)** broaden to (4 mo, ≥15) for more rewards; **(c)** broaden dormancy only (3 mo → 35).

8. **Daily-intensity middle tier?** Add `plays_30_in_day` (300 tracks) for granularity, or
   skip it in favour of the `Obsession` top tier only?

---

# Change recommendation summary

| Badge / area | Current state | Recommended action | Rationale | Migration impact |
|---|---|---|---|---|
| plays_50…200 | 2703/604/124 | **Keep** | Textbook pyramid (4.5–4.9× steps) | none |
| plays_300/400/500 | 60/34/20, shallow | **Keep, document plateau** | Data ceiling (max 931); re-tune churns history for marginal gain | none if kept |
| top_1st_month/season/year | 112/37/9, clean spread | **Keep** | Healthy, un-monopolised | none |
| top_1st_alltime | 0 | **Backfill** | An all-time #1 exists | backfill only |
| top_1st_decade | 0 | **Keep (wait)** | Next decade-end 2030 | none |
| streaks | 3570 / 500, flat middle | **Decide mid-tier** (`streak_8_years` ~1633) | 2,285 tracks unrecognised in 5–9 range | new badge_type + backfill |
| plays_20/40_in_day | 511 / 212 distinct | **Keep** | Clean 2.4:1 step | none |
| played_on_day_one | 5464 | **Keep** | Green | none |
| day_one_fan / release_week_fan | 266 / 330 | **Keep** | Thresholds on healthy shoulders | none |
| late_bloomer | 15, gated | **Loosen to >365d + decouple gate** | Rarest badge + correctness gap (19 qualify, 15 earn) | detection logic change + backfill |
| comeback | 20 | **Keep (optionally broaden)** | Prestige rarity defensible | tuning only |
| season_regular / multi_top | 13 / 23 | **Keep; spike for sensitivity** | Engine-dependent, not SQL-tunable | none now |
| NEW Unskippable | — | **Propose** (≥100 plays, 0 skips → 96) | Loyalty signal orthogonal to play count | new badge + detection |
| NEW On Repeat | — | **Propose** (≥5 consecutive <30min → 953) | Captures loop behaviour | new badge + detection |
| NEW Obsession | — | **Propose** (≥100/day → 46) | Real extreme above the 40 ceiling | new badge + detection |
| NEW Triple Crown | — | **Propose** (verify count) | Latent cross-kind rankings overlap | new badge + detection |
| NEW Night Owl / Globetrotter | — | **Drop** | 2 / 5,520 tracks — no fit for this user | none |
