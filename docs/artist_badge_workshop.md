---
title: Artist Badge System — Design Workshop
tags: [music-tracker, badge-system, artist-badges, design-review]
date: 2026-07-06
status: draft
---

# Executive summary

The listening history contains **7,038 distinct artists** across 671,163 credited
play-instances (413,835 plays × their credited artists). The distribution is heavily
long-tailed — median **2 plays/artist**, p90 = 98, p99 = 1,892, and a single dominant artist
(**D-Sturb, 30,385 plays / 236 tracks**) — but the meaningful head is clean and pyramid-shaped:
**690 artists have ≥100 plays (9.8% of all artists)**, which almost exactly mirrors the track
system's `plays_50` (top 9.2% of tracks). That symmetry means the artist arc can reuse the
track system's proven shape.

Recommended catalog: **~19 badges across 6 categories**, closely mirroring the 22 track badges.
Four categories are strongly data-supported (cumulative plays, distinct tracks, streaks,
multi-track dominance); one needs a design decision (rankings — heavily clustered, so podium
matters more than for tracks); and **one — artist "comeback" — is not viable as a track
analog** and should be reframed or dropped (evidence below).

**Key lessons carried over from the track badge audit (`track_badge_audit.md`):**

1. **Geometric spacing from day one.** The track audit found `plays_300/400/500` too shallow
   (linear +100 against a maxed dataset). Every artist tier here is geometric (×2–2.5 per
   step), so the pyramid holds all the way up.
2. **Never gate detection on an unrelated trigger.** `late_bloomer`'s plays_50 gate silently
   dropped qualifiers. Artist detection should evaluate each condition directly against
   `art_agg`, not piggyback on a milestone crossing.
3. **Don't ship a structurally dead badge.** `late_bloomer` (15 rows, 0.05%) was the audit's
   cautionary tale. Here that lesson kills artist-comeback pre-emptively: it produces **zero**
   established-favorite returns at any prestige threshold, so it is flagged rather than shipped.
4. **Podium where #1 clusters.** Track #1s spread nicely (no monopoly), so tracks never needed
   a podium. Artist #1 is the opposite — D-Sturb owns 41 of 113 months and 7 of 10 years — so a
   podium (top-3) concept is *more* justified for artists.

All figures are live production data (2026-07-06). Primary artist attribution = `artist_ids[1]`;
"all-credited" = every artist on the track (via `unnest(artist_ids)`). Where the choice matters
it is flagged — it is Design Question 1.

---

# Data analysis

## Cumulative artist plays

Attribution basis matters: **all-credited** counts a collab play for every credited artist;
**primary-only** counts it for `artist_ids[1]`. Hardstyle is collab-heavy, so the two differ
(~1.4×). Leading with all-credited; primary shown for comparison.

**Distribution (all-credited):**

| Bucket | Artists |
|---|---|
| 100–499 | 460 |
| 500–999 | 97 |
| 1,000–4,999 | 113 |
| 5,000–9,999 | 14 |
| 10,000–24,999 | 5 |
| 25,000–49,999 | 1 |
| 50,000+ | 0 |

**Cumulative ≥ threshold** (all-credited, for tier design):

| ≥100 | ≥250 | ≥500 | ≥1000 | ≥2500 | ≥5000 | ≥7500 | ≥10000 | ≥25000 |
|---|---|---|---|---|---|---|---|---|
| 690 | 360 | 230 | 133 | 53 | 20 | 8 | 6 | 1 |

Primary-only for comparison: ≥500 → 158, ≥1000 → 82, ≥2500 → 38, ≥5000 → 10, ≥10000 → 6,
max = 21,545.

**Observations.** Clean geometric decay. `≥100 = 690` is the natural entry tier (9.8% of
artists ≈ the 9.2% that `plays_50` captures for tracks). The head thins by roughly ×2 per
doubling of threshold — ideal pyramid material. All-credited vs primary changes the top artist's
total by ~40% (30,385 → 21,545), so the attribution choice is real but doesn't change the
*shape*.

## Distinct tracks per artist

**Distribution:**

| Tracks | Artists |
|---|---|
| 1 | 4,010 |
| 2–5 | 1,904 |
| 6–10 | 436 |
| 11–25 | 321 |
| 26–50 | 163 |
| 51–100 | 118 |
| 100+ | 86 |

Max = **502 tracks** (Radical Redemption). Cumulative: ≥5 → 1,315, ≥10 → 734, ≥15 → 551,
≥25 → 384, ≥50 → 207, ≥75 → 123, ≥100 → 86.

**Observations.** 57% of artists are one- or two-track acquaintances (the 4,010 + a chunk of
2–5). The "explored catalog" head is well-populated and thins geometrically: 1,315 → 734 → 384
→ 207 → 86 across 5/10/25/50/100. This is a textbook 5-tier ladder from "I know this artist" to
"I've heard their whole discography."

## Artist streaks

Consecutive calendar years with ≥1 play (gaps-and-islands, Europe/Amsterdam). Data spans
2017–2026, so max run = **10** (a data ceiling, same as tracks).

| Run length | Artists |
|---|---|
| 1 | 4,360 |
| 2 | 886 |
| 3–4 | 585 |
| 5–6 | 378 |
| 7–9 | 395 |
| 10 (ceiling) | 434 |

Cumulative: ≥3 → 1,792, ≥5 → 1,207, ≥7 → 829, ≥10 → 434.

**Observations.** Artists are proportionally *more* streak-prone than tracks (≥5-year: 17% of
artists vs 12% of tracks) — unsurprising, since staying loyal to an artist across years is
easier than to one specific track. The 5→10 gap is 1,207 → 434 (2.8:1), gentler than the track
system's 7:1, so a middle tier is less urgent — but ≥3 (1,792) makes a nice accessible entry
that tracks don't have.

## Artist rankings historically

Two ways to measure "artist was #1 of a period":

**(a) True artist-of-period** — rank artists by plays *within* each period, take the winner:

- **Artist-of-month:** 113 months → **30 distinct winners**. D-Sturb won 41, Radical
  Redemption 15, Hard Driver 11, Sub Zero Project 6, Rebelion 6.
- **Artist-of-year:** 10 years → **only 3 distinct winners** — Radical Redemption (2017–18),
  D-Sturb (2019–2025, *seven straight*), Solstice (2026).

**(b) Track-#1 aggregation** (which artists own the existing `top_1st_*` track badges): 50
artists hold ≥1 track-#1, 26 hold ≥2, 12 ≥3, 6 ≥5, 4 ≥10. D-Sturb leads with 37 track-#1s
(22 month / 10 season / 5 year).

**Observations.** Artist rankings are **heavily clustered**, the opposite of track rankings.
At year granularity it's nearly a one-artist show (D-Sturb, 7/10). This is the single most
important design signal in the workshop: a bare "artist #1 of the period" badge would be
monopolised, so a **podium (top-3)** framing is far more valuable here than it would be for
tracks — it spreads recognition to the ~30 artists who genuinely chart without diluting it.

## Comeback patterns

Artist-level comeback (mirror of the track badge): prior activity → dormancy → a big month.
Recomputed directly from monthly artist plays:

| Dormancy | Min plays in comeback month | Artists |
|---|---|---|
| 6 mo | 50 | 17 |
| 12 mo | 50 | 9 |
| 6 mo | 30 | 37 |
| 12 mo | 100 | 1 |

**Critical finding.** I filtered these candidates by *prior history* and the result is decisive:
**at 6-mo dormancy / ≥30-play return, the maximum prior history of any comeback artist is 81
plays, and ZERO have ≥100 prior plays** (0 at ≥100, 0 at ≥250). In other words, the classic
"established favorite goes silent for a year then roars back" pattern **does not exist in this
data** — the core artists (D-Sturb, Radical Redemption, …) are played too continuously to ever
go dormant. The dormancy pattern only ever catches *minor-artist rediscoveries*.

Top candidates (12-mo dormant, ≥50-play return month, ordered by comeback size):

| Artist | Comeback month | Plays that month | Last active before | Prior total |
|---|---|---|---|---|
| Luner | 2023-01 | 260 | 2021-11 | 1 |
| Nico Moreno | 2024-03 | 79 | 2022-07 | 6 |
| Jyye | 2022-12 | 79 | 2019-10 | 4 |
| Satronica | 2025-03 | 68 | 2022-11 | 13 |
| The Dope Doctor | 2021-05 | 65 | 2020-04 | 9 |

Every one is a rediscovery of a barely-known artist (prior totals in single/low-double digits),
not a lapsed favorite returning. This directly shapes the recommendation (reframe as
"Rediscovery" or drop — see catalog).

## Multi-track top presence

Artists with ≥N distinct tracks in the **current all-time Top 100** (by total play count):

| N | Primary artist | Any credited artist |
|---|---|---|
| ≥2 | 9 | 18 |
| ≥3 | **7** | 10 |
| ≥5 | 6 | 6 |
| ≥10 | 2 | 4 |
| max | 34 (D-Sturb) | 43 (D-Sturb) |

Top of the Top 100 (any-credited): D-Sturb 43, Warface 17, Sub Zero Project 13, Rebelion 12,
Hard Driver 8, RVAGE 7.

**Observations.** The set is top-heavy and *stable across N*: ≥3 and ≥5 differ by only one
artist (primary: 7 vs 6), because artists who clear 3 usually clear far more (D-Sturb has 34).
So **N=3 is the sweet spot** — it excludes one-hit favorites and admits the 7–10 genuine
multi-track powerhouses; N=5 is barely more exclusive, N=2 barely less. D-Sturb owning ~a third
of the all-time Top 100 is the headline stat of the entire dataset.

---

# Proposed badge catalog

`badge_events` already permits `entity_type='artist'` (migration 0014 CHECK) — **no schema
change is needed** to start awarding artist badges. `entity_id` = Spotify `artist_id`. Names
are hardstyle-flavoured suggestions, swappable.

## Cumulative milestones (proposal: 6 tiers)

Basis: all-credited plays (Design Question 1). Geometric, per the track-audit lesson.

| Tier | Name (suggestion) | Threshold | Expected artists | Multi-fire | Trigger | Rationale |
|---|---|---|---|---|---|---|
| 1 | **Recruit** | ≥100 plays | 690 | No | daily artist job | Entry ≈ `plays_50` (9.8% of artists) |
| 2 | **Soldier** | ≥250 | 360 | No | daily | ×2.5, still broad |
| 3 | **Warrior** | ≥500 | 230 | No | daily | mid-loyalty |
| 4 | **Veteran** | ≥1,000 | 133 | No | daily | serious devotion |
| 5 | **Warlord** | ≥2,500 | 53 | No | daily | rare |
| 6 | **Legend** | ≥5,000 | 20 | No | daily | peak — 20 artists, mirrors `plays_500` (20 tracks) |

SQL: `SELECT artist_id FROM art_agg WHERE plays_all >= <tier>` where `art_agg` aggregates
`unnest(artist_ids)` joined to `spotify_plays`. **Context JSONB:** `{"plays": <n>, "basis":
"all_credited"}`. Single-fire (NULL window). Shrink factors 0.52/0.64/0.58/0.40/0.38 — a clean
pyramid all the way up.

## Distinct-tracks milestones (proposal: 5 tiers)

| Tier | Name | Threshold | Expected artists | Multi-fire | Trigger |
|---|---|---|---|---|---|
| 1 | **Digger** | ≥5 tracks | 1,315 | No | daily |
| 2 | **Collector** | ≥10 | 734 | No | daily |
| 3 | **Curator** | ≥25 | 384 | No | daily |
| 4 | **Archivist** | ≥50 | 207 | No | daily |
| 5 | **Completionist** | ≥100 | 86 | No | daily |

SQL: `WHERE tracks >= <tier>` on `art_agg.tracks` (distinct `track_uri` per artist).
**Context:** `{"distinct_tracks": <n>}`. Rationale: spans "I know this artist" (1,315) to "I've
heard their whole discography" (86) with clean ×~2 steps.

## Streaks (proposal: 3 tiers)

| Tier | Name | Threshold | Expected artists | Multi-fire | Trigger |
|---|---|---|---|---|---|
| 1 | **Constant** | ≥3 consecutive years | 1,792 | No | daily |
| 2 | **Faithful** | ≥5 consecutive years | 1,207 | No | daily |
| 3 | **Eternal** | ≥10 consecutive years | 434 | No | daily |

SQL: gaps-and-islands over distinct `EXTRACT(YEAR …)` per `artist_id` (identical shape to
`detect_streak_badges`, keyed on artist). **Context:** `{"years": <run_len>, "run_start":
<year>}`. The 5→10 gap (2.8:1) is gentle, so an intermediate `≥7` (829) is optional, not needed
— but the accessible `≥3` entry (1,792) is worth adding since artist streaks are common enough
to reward earlier than track streaks. (Design Question 3.)

## Rankings (proposal: 5 + podium decision)

The `top_1st_artist_*` family — artist with the most plays in a period. **True artist-of-period
ranking** (rank artists by in-period plays), *not* aggregation of track-#1s.

| Badge | Name | Definition | Expected (distinct winners) | Multi-fire | Trigger |
|---|---|---|---|---|---|
| top_1st_artist_month | **Reigning** | #1 artist of a calendar month | 30 winners / 113 months | Yes (`window`=month) | `create_snapshots.py` month-end |
| top_1st_artist_season | **Reigning (season)** | #1 of an astronomical season | ~15–20 est. (needs season calc) | Yes | season-end |
| top_1st_artist_year | **Sovereign** | #1 artist of a calendar year | **3 winners / 10 years** | Yes (`window`=year) | year-end |
| top_1st_artist_alltime | **Immortal** | #1 artist all-time | 1 (D-Sturb) | Yes | snapshot |
| top_1st_artist_decade | **Dynasty of the Decade** | #1 of a decade | 0 today (next 2030) | Yes | decade-end |

SQL: `SELECT artist_id FROM play_artist WHERE <period> GROUP BY artist_id ORDER BY COUNT(*)
DESC LIMIT 1` (mirrors `_ranked_with_plays`). **Context:** `{"window": "<period>", "plays":
<n>}`.

**Podium sub-proposal (strongly recommended for artists):** because #1 is monopolised (D-Sturb
7/10 years), add a **`podium_artist_*`** family = top-3 artist of a period. This spreads
recognition to the ~30 charting artists. Expected: month top-3 ≈ 60–70 distinct artists over
113 months. Two shapes to choose (Design Question 2): separate `top_2nd`/`top_3rd`, or a single
`podium` badge for "top-3 of the period".

## Comeback → reframe as "Rediscovery" (or defer)

**Do not ship artist comeback as a track analog.** Evidence: 0 artists with ≥100 prior plays
ever go dormant then spike (max prior = 81). The pattern only catches minor-artist
rediscoveries.

| Option | Name | Definition | Expected | Multi-fire | Trigger |
|---|---|---|---|---|---|
| Reframe | **Rediscovery** | prior ≥50 plays total, ≥6 mo dormant, then ≥30 plays in a month | ~17–37 | Yes (`window`=month) | daily |
| Defer | — | drop from v1; revisit if a core artist ever lapses | 0 | — | — |

Concrete examples (Rediscovery framing): **Luner** (260 plays Jan 2023 after 14 mo away),
**Nico Moreno** (79 plays Mar 2024), **Jyye** (79 plays Dec 2022). **Context:** `{"window":
"<month>", "plays": <n>, "last_active": "<month>", "prior_total": <n>}`. Recommendation: ship
as **Rediscovery** with the honest, looser framing, or defer — but never as "comeback" at
prestige thresholds, which would be a dead badge.

## Multi-track top (proposal: 1 badge, N=3)

| Badge | Name | Definition | Expected | Multi-fire | Trigger |
|---|---|---|---|---|---|
| artist_dynasty | **Dynasty** | ≥3 distinct tracks in the current all-time Top 100 | 7 (primary) / 10 (any-credited) | No (live state) | weekly `update_managed_playlists.py` |

SQL: rank tracks by all-time plays, take top 100, group by artist, `HAVING COUNT(DISTINCT
track_uri) >= 3`. **Context:** `{"tracks_in_top100": <n>, "basis": "primary"}`. N=3 chosen: ≥3
and ≥5 differ by one artist, so 3 is exclusive-but-not-trivial; N=2 admits borderline cases,
N=5 adds no meaningful selectivity. Mirrors the track `multi_top` "live current-state" pattern.

---

# Design questions for user

1. **Attribution basis for cumulative-plays & tracks badges — all-credited or primary-only?**
   All-credited counts collab plays for every credited artist (hardstyle-friendly, ~1.4× more
   generous); primary-only counts `artist_ids[1]`. Options: **(a)** all-credited *(recommended
   — rewards presence on the track)*; **(b)** primary-only (stricter, "whose track is it");
   **(c)** all-credited for plays, primary-only for the ranking/dynasty badges.

2. **Rankings podium — how to handle the heavy #1 clustering?** D-Sturb owns 7/10 years.
   Options: **(a)** add a `podium_artist_*` (top-3) family alongside `top_1st_artist_*`
   *(recommended — spreads recognition)*; **(b)** `top_1st` only and accept a near-monopoly;
   **(c)** separate `top_2nd`/`top_3rd` badges per period.

3. **Streak tiers — 3/5/10, or match tracks at 5/10?** Options: **(a)** 3/5/10 *(recommended —
   artist streaks are common enough to reward a 3-year entry)*; **(b)** 5/10 to mirror tracks
   exactly; **(c)** 3/5/7/10 (adds the 829-artist ≥7 middle tier).

4. **Artist comeback — reframe, or defer?** No established favorite ever goes dormant (max
   prior 81 plays). Options: **(a)** ship as **Rediscovery** with looser framing (~17–37
   artists) *(recommended)*; **(b)** defer entirely to a later release; **(c)** ship as
   "comeback" anyway at loose thresholds (misleading name — not recommended).

5. **Catalog size for v1 — full ~19 or a lean core first?** Options: **(a)** ship cumulative +
   distinct-tracks + streaks + dynasty first (16 badges, all daily/weekly, no snapshot
   dependency), add rankings in a follow-up; **(b)** ship all six categories at once;
   **(c)** cumulative + streaks only as a minimal pilot.

---

# Complete badge catalog summary

| Category | Badge | Threshold / definition | Expected volume | Multi-fire | Trigger |
|---|---|---|---|---|---|
| Cumulative | Recruit | ≥100 plays | 690 | No | daily |
| Cumulative | Soldier | ≥250 plays | 360 | No | daily |
| Cumulative | Warrior | ≥500 plays | 230 | No | daily |
| Cumulative | Veteran | ≥1,000 plays | 133 | No | daily |
| Cumulative | Warlord | ≥2,500 plays | 53 | No | daily |
| Cumulative | Legend | ≥5,000 plays | 20 | No | daily |
| Distinct tracks | Digger | ≥5 tracks | 1,315 | No | daily |
| Distinct tracks | Collector | ≥10 tracks | 734 | No | daily |
| Distinct tracks | Curator | ≥25 tracks | 384 | No | daily |
| Distinct tracks | Archivist | ≥50 tracks | 207 | No | daily |
| Distinct tracks | Completionist | ≥100 tracks | 86 | No | daily |
| Streak | Constant | ≥3 consecutive years | 1,792 | No | daily |
| Streak | Faithful | ≥5 consecutive years | 1,207 | No | daily |
| Streak | Eternal | ≥10 consecutive years | 434 | No | daily |
| Rankings | Reigning (month) | #1 artist of month | 30 winners | Yes | snapshots |
| Rankings | Reigning (season) | #1 artist of season | ~15–20 | Yes | snapshots |
| Rankings | Sovereign (year) | #1 artist of year | 3 winners | Yes | snapshots |
| Rankings | Immortal (all-time) | #1 artist all-time | 1 | Yes | snapshots |
| Rankings | Dynasty of the Decade | #1 artist of decade | 0 (2030) | Yes | snapshots |
| Multi-track | Dynasty | ≥3 tracks in all-time Top 100 | 7–10 | No | weekly |
| Behavioral | Rediscovery *(optional)* | prior ≥50, ≥6mo dormant, ≥30/mo | 17–37 | Yes | daily |
| Rankings | Podium *(optional)* | top-3 artist of a period | ~60–70 (month) | Yes | snapshots |

Core: **19 badges** (6 + 5 + 3 + 5). Optional add-ons: Rediscovery, Podium family.

---

# Alignment with track badge system

| Track category (22) | Artist mirror | Deliberate deviation |
|---|---|---|
| Play milestones (6: 50…500) | Cumulative plays (6: 100…5,000) | **Geometric, not linear-tailed** — fixes the `plays_300/400/500` plateau flagged in the audit. Entry (≥100 = 9.8%) tuned to match `plays_50` (9.2%). |
| — (no track equivalent) | Distinct tracks (5) | **New axis** — "breadth of catalog explored" has no track analog; it's inherently an artist concept. |
| Streaks (2: 5, 10 yr) | Streaks (3: 3, 5, 10 yr) | Added an accessible **≥3-year** entry — artist streaks are proportionally more common (17% vs 12% at ≥5yr), so an earlier tier is earned. |
| Rankings (5: `top_1st_*`) | Rankings (5: `top_1st_artist_*`) + **Podium** | Same 5-period structure, but adds a **podium** family because artist #1 is monopolised (D-Sturb 7/10 years) where track #1 was well-spread. |
| Behavioral → comeback | **Rediscovery** (reframed) or deferred | Deliberately **not** a 1:1 mirror — the data proves established-artist comeback doesn't exist (max prior 81 plays), so shipping "comeback" would repeat the `late_bloomer` dead-badge mistake. |
| Behavioral → multi_top (≥10 playlists) | **Dynasty** (≥3 tracks in Top 100) | Simpler, single-surface definition; the broad-playlist-universe recompute is deferred to a later phase. |
| Daily intensity, release timing | *(not mirrored)* | These are track-lifecycle concepts (a single track's release/day). No natural artist analog, so intentionally omitted. |

**Where I guessed** (all surfaced in Design Questions): attribution basis (all-credited),
streak entry at 3 years, comeback reframed to Rediscovery, Dynasty at N=3, podium recommended.
Season-level ranking volumes are estimates (astronomical season boundaries weren't recomputed
in this pass — flagged, not silently assumed).
