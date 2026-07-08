---
title: Badge System Definitions
tags: [music-tracker, badge-system, reference]
date: 2026-07-03
version: v0.67.1
---

# Music-tracker Badge System

Complete reference of all badge types, their semantic definitions, detection queries, and
edge cases. Auto-generated during the v0.67.1 audit. All SQL below is copied **verbatim**
from `lib/badges.py` (and `lib/playlists.py` for the ranking source) so this document
reflects the code as shipped, not a paraphrase.

All badges live in one table, `badge_events`:

```sql
CREATE TABLE badge_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('track', 'artist')),
  entity_id TEXT NOT NULL,          -- track_uri
  badge_type TEXT NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context JSONB DEFAULT '{}'::jsonb,
  UNIQUE (entity_type, entity_id, badge_type)   -- dropped in 0015, see below
);
```

Uniqueness is enforced by the migration-0015 windowed index, **not** the original
constraint:

```sql
CREATE UNIQUE INDEX badge_events_unique_awarded
  ON badge_events (entity_type, entity_id, badge_type, (context->>'window'))
  NULLS NOT DISTINCT;
```

- **Single-fire badges** carry no `context->>'window'` (it is NULL). `NULLS NOT DISTINCT`
  treats two NULLs as equal → exactly one row per `(track, badge_type)`.
- **Multi-fire badges** put a discriminator in `context['window']` (a date, month, or period
  name) → one row per `(track, badge_type, window)`.

## Categories

- [Play milestones](#play-milestones) (6 badges)
- [Rankings](#rankings) (5 badges)
- [Streaks](#streaks) (2 badges)
- [Daily intensity](#daily-intensity) (2 badges)
- [Release timing](#release-timing) (4 badges)
- [Behavioral](#behavioral) (3 badges)

**Total: 22 badge types**

---

## Play milestones

Six thresholds. Once per track (single-fire, NULL window). Detection is batch-scoped and
piggy-backs on the 30-minute recently-played ingest cron
(`process_batch_milestones` → `detect_new_play_milestones`).

**Detection query** (shared by all six thresholds; verbatim from `detect_new_play_milestones`):

```sql
WITH batch_tracks AS (
  SELECT unnest(%s::text[]) AS track_uri
),
totals AS (
  SELECT bt.track_uri, COUNT(sp.track_uri) AS plays
  FROM batch_tracks bt
  JOIN spotify_plays sp ON sp.track_uri = bt.track_uri
  WHERE sp.track_uri IS NOT NULL
  GROUP BY bt.track_uri
),
thresholds AS (
  SELECT unnest(ARRAY[50, 100, 200, 300, 400, 500]) AS n
),
should_award AS (
  SELECT t.track_uri, th.n
  FROM totals t
  CROSS JOIN thresholds th
  WHERE t.plays >= th.n
)
SELECT sa.track_uri, sa.n
FROM should_award sa
LEFT JOIN badge_events be
  ON be.entity_type = 'track'
  AND be.entity_id = sa.track_uri
  AND be.badge_type = 'plays_' || sa.n
WHERE be.id IS NULL
ORDER BY sa.track_uri, sa.n
```

**Backfill logic** (`scripts/backfill_play_milestones.py`): for each track, `awarded_at` =
the `played_at` of the Nth play (the crossing moment), via `ROW_NUMBER() ... WHERE rn IN
(50,100,200,300,400,500)`. Live detection uses `awarded_at = NOW()`.

**Edge cases**: NULL `track_uri` filtered (Lesson #17). Scoped to the exact `track_uri`, not
canonical-aggregated across URI variants (deferred to v0.70). Crossing plays_50 is also the
trigger point for the release-timing family (see below).

### plays_50
**Semantic**: played ≥50 times cumulatively (all-time). **Multi-fire**: No. **Trigger**:
ingest cron, batch-scoped. **Mail subject**: `music-tracker: '{track}' just hit 50+ plays`

### plays_100
**Semantic**: ≥100 cumulative plays. **Multi-fire**: No. **Trigger**: ingest cron.

### plays_200
**Semantic**: ≥200 cumulative plays. **Multi-fire**: No. **Trigger**: ingest cron.

### plays_300
**Semantic**: ≥300 cumulative plays. **Multi-fire**: No. **Trigger**: ingest cron.

### plays_400
**Semantic**: ≥400 cumulative plays. **Multi-fire**: No. **Trigger**: ingest cron.

### plays_500
**Semantic**: ≥500 cumulative plays. **Multi-fire**: No. **Trigger**: ingest cron.
**Mail subject**: `music-tracker: '{track}' just hit 500+ plays`

---

## Rankings

The `top_1st_*` family: being the **#1 most-played track of a period**. Awarded by the daily
`scripts/create_snapshots.py` cron the morning after a period ends, to the #1 of the freshly
created period snapshot. **Multi-fire** via `context['window']` = the period display name
(e.g. `"January 2026"`) — a track can be #1 of many periods.

**Ranking source** (verbatim from `lib/playlists.py::_ranked_with_plays`, used by
`rank_period_tracks`; the row at rank 1 receives the badge):

```sql
SELECT track_uri, COUNT(*) AS plays
FROM spotify_plays
WHERE track_uri IS NOT NULL
  AND {where_sql}          -- period predicate from snapshot_period_spec()
GROUP BY track_uri
ORDER BY plays DESC, MIN(played_at) ASC
LIMIT {limit}
```

**Award** (verbatim from `award_top_1st_badge`):

```sql
INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
VALUES ('track', %s, %s, %s, %s::jsonb)
ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window'))
    DO NOTHING
RETURNING id
```

**Backfill logic** (`scripts/backfill_top1st_badges.py`): parses existing Spotify snapshot
playlists, takes position 1, `awarded_at` = the period-end date. **Edge cases**: `top_1st_alltime`
and `top_1st_decade` are currently unpopulated (no all-time/decade snapshots backfilled yet →
Rankings-strip rows show an em-dash). Tie-break is `MIN(played_at) ASC`.

### top_1st_month
**Semantic**: #1 most-played track of a calendar month (Top 25 snapshot). **Multi-fire**: Yes
(`window` = e.g. `"January 2026"`). **Trigger**: `create_snapshots.py`, month-end.
**Mail**: dedicated snapshot mail (not the generic template).

### top_1st_season
**Semantic**: #1 of an astronomical season (Top 50). **Multi-fire**: Yes. **Trigger**:
`create_snapshots.py`, season-end.

### top_1st_year
**Semantic**: #1 of a calendar year (Top 100). **Multi-fire**: Yes. **Trigger**: year-end.

### top_1st_alltime
**Semantic**: #1 all-time. **Multi-fire**: Yes (per all-time snapshot). **Trigger**:
`create_snapshots.py`. **Note**: not backfilled in v0.65 → currently 0 rows.

### top_1st_decade
**Semantic**: #1 of a decade (Top 100). **Multi-fire**: Yes. **Trigger**: decade-end (next
occurs 2030-01-01) → currently 0 rows.

---

## Streaks

Longevity: playing a track across many consecutive calendar years. Once per track
(single-fire). Detected on the ingest cron (batch mode) and the backfill (full mode) via
`detect_streak_badges` (gaps-and-islands over distinct local years).

**Detection query** (verbatim from `detect_streak_badges`; `{where_batch}` is
`AND sp.track_uri = ANY(%s)` in batch mode, empty in full mode):

```sql
WITH years AS (
    SELECT DISTINCT sp.track_uri,
           EXTRACT(YEAR FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int AS yr
    FROM spotify_plays sp
    WHERE sp.track_uri IS NOT NULL
      {where_batch}
),
islands AS (
    SELECT track_uri, yr,
           yr - ROW_NUMBER() OVER (PARTITION BY track_uri ORDER BY yr) AS island
    FROM years
),
runs AS (
    SELECT track_uri, MIN(yr) AS run_start, COUNT(*) AS run_len
    FROM islands
    GROUP BY track_uri, island
),
best AS (
    SELECT DISTINCT ON (track_uri) track_uri, run_start, run_len
    FROM runs
    ORDER BY track_uri, run_len DESC, run_start ASC
)
SELECT track_uri, run_start, run_len FROM best WHERE run_len >= 5
```

**Backfill logic**: `awarded_at` = first play of the Nth consecutive year of the longest run
(`_first_play_in_year(track, run_start + N - 1)`). **Edge cases**: uses the *longest* run, so a
track with two separate 5-year runs is dated by the longest one. Consecutiveness is by calendar
year in Europe/Amsterdam, not rolling 365-day windows.

The Python award loop runs thresholds `n ∈ {5, 8, 10}` against each track's longest run.

### streak_5_years
**Semantic**: ≥1 play in each of 5 consecutive calendar years. **Multi-fire**: No.
**Trigger**: ingest cron / backfill. **Mail subject**: `music-tracker: '{track}' just hit a
5-year streak`

### streak_8_years (v0.74)
**Semantic**: ≥1 play in each of 8 consecutive calendar years. **Multi-fire**: No. **Trigger**:
ingest cron / backfill. **Rationale**: the audit found a flat 5–9-year plateau with ~2,285
tracks unrecognised between the 5y and 10y tiers; the geometric midpoint √(3570·500) ≈ 1,336
lands closest to `≥8 = 1,633`. **Mail subject**: `music-tracker: '{track}' — 8-year streak
achievement`. **Backfill volume**: 1,633.

### streak_10_years
**Semantic**: ≥1 play in each of 10 consecutive calendar years. **Multi-fire**: No.
**Mail subject**: `music-tracker: '{track}' — 10-year streak achievement`

---

## Daily intensity

Bursts: many plays of one track on a single day. **Multi-fire** via `context['window']` = the
date (`"2026-07-15"`) — each `(track, day)` awards at most once. Detected on the ingest cron
(batch mode) and backfill (full mode) via `detect_daily_intensity_badges`.

**Detection query** (verbatim; run once per threshold `n ∈ {20, 40}`):

```sql
WITH daily AS (
    SELECT sp.track_uri,
           (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS day,
           COUNT(*) AS plays
    FROM spotify_plays sp
    WHERE sp.track_uri IS NOT NULL
      {where_batch}
    GROUP BY sp.track_uri, day
    HAVING COUNT(*) >= %s
)
SELECT d.track_uri, d.day, d.plays
FROM daily d
LEFT JOIN badge_events be
  ON be.entity_type = 'track' AND be.entity_id = d.track_uri
  AND be.badge_type = %s AND be.context->>'window' = d.day::text
WHERE be.id IS NULL
ORDER BY d.track_uri, d.day
```

**Backfill logic**: `awarded_at` = end of that day (23:59:59 local). A day with ≥40 plays
awards **both** `plays_20_in_day` and `plays_40_in_day` (cascade by design).

The detection query runs once per threshold `n ∈ {20, 40, 60}` (v0.74 added 60).

### plays_20_in_day
**Semantic**: ≥20 plays of one track on one local day. **Multi-fire**: Yes (`window` = date).
**Trigger**: ingest cron / backfill.

### plays_40_in_day
**Semantic**: ≥40 plays of one track on one local day. **Multi-fire**: Yes.

### plays_60_in_day (v0.74)
**Semantic**: ≥60 plays of one track on one local day — an "obsession day". **Multi-fire**: Yes.
**Rationale**: the audit found real single-day obsession peaks (max 224 plays/day) that the 40
ceiling left unrecognised (119 distinct tracks ≥60/day). Cascade: a ≥60 day also awards 20 & 40.
**Backfill volume**: 146 instances.

---

## Release timing

How a track relates to its release date. **v0.67.1 tightened this whole family** to scope on
plays *within the time window* rather than total plays. All require **day-precision**
`release_date` in `track_metadata` (`release_date_precision = 'day'`, ~99% of the catalog).

`played_on_day_one` is detected on the ingest cron (`detect_release_timing_badges`).
`day_one_fan` and `release_week_fan` are evaluated when a track crosses **plays_50**
(`detect_release_timing_at_50_plays`, called from `record_and_notify_milestone`) — both can
fire (they genuinely require ≥50 plays, so the gate is intentional).

**v0.74 — `late_bloomer` decoupled.** It no longer runs at the plays_50 crossing. `late_bloomer`
has no total-play requirement, so gating it on plays_50 silently dropped qualifiers with 30–49
total plays (audit: 19 qualify, only 15 earned). It now runs independently on the ingest cron
(batch mode) and backfill (full mode) via the standalone `detect_late_bloomer_badges`, rescuing
the 4 missing tracks (15 → 19).

**`played_on_day_one` query** (verbatim from `detect_release_timing_badges`):

```sql
WITH firsts AS (
    SELECT sp.track_uri, MIN(sp.played_at) AS first_play_at
    FROM spotify_plays sp
    WHERE sp.track_uri IS NOT NULL
      {where_batch}
    GROUP BY sp.track_uri
)
SELECT f.track_uri, f.first_play_at, tm.release_date
FROM firsts f
JOIN track_metadata tm ON tm.track_uri = f.track_uri
LEFT JOIN badge_events be
  ON be.entity_type = 'track' AND be.entity_id = f.track_uri
  AND be.badge_type = 'played_on_day_one' AND be.context->>'window' IS NULL
WHERE tm.release_date_precision = 'day'
  AND tm.release_date IS NOT NULL
  AND (f.first_play_at AT TIME ZONE 'Europe/Amsterdam')::date = tm.release_date::date
  AND be.id IS NULL
ORDER BY f.track_uri
```

**`day_one_fan` / `release_week_fan` counts** (verbatim from `detect_release_timing_at_50_plays`
— one query computes both windowed counts):

```sql
SELECT
    tm.release_date,
    MIN(sp.played_at) AS first_play_at,
    COUNT(*) FILTER (
        WHERE (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date = tm.release_date::date
    ) AS plays_on_release_day,
    COUNT(*) FILTER (
        WHERE (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date
              BETWEEN tm.release_date::date AND tm.release_date::date + 7
    ) AS plays_in_release_week
FROM track_metadata tm
JOIN spotify_plays sp ON sp.track_uri = tm.track_uri
WHERE tm.track_uri = %s
  AND tm.release_date_precision = 'day'
  AND tm.release_date IS NOT NULL
GROUP BY tm.release_date
```

`day_one_fan` awards when `plays_on_release_day >= 20`; `release_week_fan` when
`plays_in_release_week >= 50` (the week is **inclusive of release day**, so 50 plays all on
day 0 earns both).

**`late_bloomer` engagement query** (verbatim; only run when `gap_days > 730`):

```sql
SELECT COUNT(*) FROM spotify_plays
WHERE track_uri = %s
  AND played_at BETWEEN %s AND %s          -- [first_play_at, first_play_at + 90 days]
```

`late_bloomer` awards when that count `>= 30`.

**Backfill logic** (`_release_timing_at_50_full` in the backfill script): sweeps every track
with ≥50 total plays through `detect_release_timing_at_50_plays`. `awarded_at`: `day_one_fan`
= close of release day; `release_week_fan` = close of release week (day 7); `late_bloomer` =
`first_play_at`.

**Edge cases / limitations**:
- Tracks without day-precision `release_date` (~1% of catalog) can never earn any of these four.
- **`day_one_fan` is only evaluated at the plays_50 crossing.** A track with ≥20 release-day
  plays but <50 *total* plays never reaches the trigger and so won't earn `day_one_fan`.
  `release_week_fan` (≥50 in-week ⇒ ≥50 total) and `late_bloomer` (≥30-in-90d, but the sweep is
  gated on ≥50 total) share the same ≥50-total gate.

### played_on_day_one
**Semantic** (v0.67.1, was `played_on_release_day`): first play landed on the release date. No
play-count threshold — "I heard it on day one." **Multi-fire**: No. **Trigger**: ingest cron.
**Mail subject**: `music-tracker: '{track}' played on day one`

### day_one_fan
**Semantic** (v0.67.1, was `day_one_stan`): ≥20 plays **on the release day itself**. The
v0.67 version only required first-play-within-7-days regardless of count — now it demands real
day-zero engagement. **Multi-fire**: No. **Trigger**: plays_50 crossing / backfill.
**Mail subject**: `music-tracker: Day-one fan achievement — '{track}'`

### release_week_fan
**Semantic** (v0.67.1, NEW): ≥50 plays within the release week (days 0–7, inclusive of day
one). **Multi-fire**: No. **Trigger**: plays_50 crossing / backfill.
**Mail subject**: `music-tracker: Release-week fan — '{track}'`

### late_bloomer
**Semantic** (v0.67.1, tightened): first play >730 days (2 years) after release **AND** ≥30
plays within the first 90 days after that first play. The v0.67 version only required a >2y gap
and ≥50 total plays whenever. **Multi-fire**: No. **Trigger**: plays_50 crossing / backfill.
**Mail subject**: `music-tracker: Late bloomer badge — '{track}'`

---

## Behavioral

### comeback
**Semantic**: prior history, then ≥6 consecutive months with zero plays, then ≥20 plays in a
single month. **Multi-fire**: Yes (`window` = comeback month `"2026-07"`). **Trigger**: ingest
cron / backfill.

**Detection query** (verbatim from `detect_comeback_badges`):

```sql
WITH monthly AS (
    SELECT sp.track_uri,
           date_trunc('month', sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS mon,
           COUNT(*) AS plays
    FROM spotify_plays sp
    WHERE sp.track_uri IS NOT NULL
      {where_batch}
    GROUP BY sp.track_uri, mon
),
candidates AS (
    SELECT track_uri, mon, plays FROM monthly WHERE plays >= 20
)
SELECT c.track_uri, c.mon, c.plays,
       (SELECT MAX(m.mon) FROM monthly m
         WHERE m.track_uri = c.track_uri AND m.mon < c.mon) AS last_active
FROM candidates c
WHERE NOT EXISTS (
    SELECT 1 FROM monthly m
    WHERE m.track_uri = c.track_uri
      AND m.mon >= (c.mon - INTERVAL '6 months')
      AND m.mon <  c.mon
)
AND EXISTS (
    SELECT 1 FROM monthly m
    WHERE m.track_uri = c.track_uri
      AND m.mon < (c.mon - INTERVAL '6 months')
)
ORDER BY c.track_uri, c.mon
```

**Backfill logic**: `awarded_at` = end of the comeback month. **Edge cases**: the `EXISTS
... < mon-6` clause requires activity *before* the dormancy, so a brand-new track's first big
month is a debut, not a comeback.

### season_regular
**Semantic**: landed in the **top 25 of ≥3 different seasonal snapshots**. **Multi-fire**: No.
**Trigger**: `create_snapshots.py` after a season snapshot is created (scoped to that snapshot's
top 25); full mode in backfill.

**Detection**: no SQL of its own — it recomputes each completed season's ranking deterministically
from `spotify_plays` via `rank_period_tracks(conn, "season", (season, start_year))` (snapshot
playlists store no membership in Postgres) and counts the seasons in whose top 25 a track appears.
`awarded_at` = end of the 3rd qualifying season. **Edge cases**: season top-25 is the first 25 of
the Top-50 season ranking; seasons are astronomical (Europe/Amsterdam), enumerated from the
play-history span.

### multi_top
**Semantic**: currently in **≥10 Top playlists simultaneously** (`MULTI_TOP_THRESHOLD = 10`).
**Multi-fire**: No. **Trigger**: weekly cron completion (`update_managed_playlists.py`), full
mode.

**Detection**: no SQL of its own — `_multi_top_universe` enumerates every currently-existing Top
playlist (3 updating tops: Top 100 all-time, Top 100 this year, Top 50 last 30 days; plus one
snapshot per completed month/season/year), each recomputed from `spotify_plays`, and counts how
many a track sits in right now. `awarded_at` = NOW() (live current-state achievement).

> ✅ **Audit flag — cosmetic mismatch (fixed in v0.67.1).** The threshold is **10**
> (`MULTI_TOP_THRESHOLD`); an earlier build's mail subject and headline still read *"5+ Top
> playlists"* (inherited from v0.67, when 5 was briefly considered). Both the subject
> (`music-tracker: '{track}' hit 10+ Top playlists simultaneously`) and the headline
> (`Multi-top (10+ Top playlists)`) now match the threshold.

**Edge cases**: `≥10` was chosen (over the definition's literal "≥5") to keep the badge
prestigious against ~10 years of data; the broad universe (~160 playlists) makes ≥5 far too
common. Enumeration cost (~160 rank recomputations) is paid only at weekly-cron completion and in
the backfill, never on the ingest hot path.

### on_repeat (v0.74)
**Semantic**: the track was played back-to-back in **≥5 separate loop sessions of ≥10
consecutive plays each** (no other track in between). **Multi-fire**: No. **Trigger**: ingest
cron (batch mode) / backfill. **Context**: `{qualifying_sessions, longest_run, example_dates}`.

**Detection** (`detect_on_repeat_badges`): gaps-and-islands over the global play timeline — a new
session starts whenever the previous play was a different `track_uri`; a run of ≥10 qualifies;
≥5 such runs earns the badge. `awarded_at` = start of the 5th qualifying session.

```sql
WITH consecutive AS (
    SELECT sp.track_uri, sp.played_at,
           LAG(sp.track_uri) OVER (ORDER BY sp.played_at) AS prev_uri
    FROM spotify_plays sp WHERE sp.track_uri IS NOT NULL
),
grouped AS (
    SELECT track_uri, played_at,
           SUM(CASE WHEN prev_uri IS DISTINCT FROM track_uri THEN 1 ELSE 0 END)
               OVER (ORDER BY played_at) AS session_group
    FROM consecutive
),
runs AS (
    SELECT track_uri, session_group, COUNT(*) AS run_length, MIN(played_at) AS run_start
    FROM grouped GROUP BY track_uri, session_group HAVING COUNT(*) >= 10
)
SELECT track_uri, COUNT(*) AS qualifying_sessions
FROM runs GROUP BY track_uri HAVING COUNT(*) >= 5
```

**Backfill volume**: 53.

---

## Rankings meta (v0.74)

Meta-badges over the existing `top_1st_month` data — a track that owned the monthly #1 in
multiple months (not necessarily consecutive). Single-fire lifetime achievements. **Trigger**:
`create_snapshots.py`, checked on each fresh `top_1st_month` award (scoped to the winning track);
full mode in backfill via `detect_dominant_sovereign_badges`. `awarded_at` = the awarded_at of
the 2nd (dominant) / 3rd (sovereign) monthly-#1 win. **Context**: `{months_won: [...]}`.

```sql
SELECT entity_id,
       array_agg(context->>'window' ORDER BY awarded_at) AS windows,
       array_agg(awarded_at ORDER BY awarded_at) AS ats
FROM badge_events
WHERE entity_type = 'track' AND badge_type = 'top_1st_month'
GROUP BY entity_id HAVING COUNT(*) >= 2
```

### dominant
**Semantic**: the track was the #1 track of **≥2 different months**. **Mail subject**:
`music-tracker: '{track}' is Dominant (2+ monthly #1s)`. **Backfill volume**: 2.

### sovereign
**Semantic**: the track was the #1 track of **≥3 different months**. **Mail subject**:
`music-tracker: '{track}' is Sovereign (3+ monthly #1s)`. **Backfill volume**: 1.

---

## Artist badges (v0.74)

A parallel badge arc keyed on Spotify `artist_id` (`entity_type='artist'` — `badge_events`
already permits it, migration 0014 CHECK, so **no schema change**). 21 types across 6 categories,
implemented in `lib/artist_badges.py`. Attribution basis = **all-credited**: a play counts for
every credited artist via `unnest(track_metadata.artist_ids)`. Detection mirrors the track
two-mode contract (a list of `artist_id`s scopes it; `None` = full backfill sweep). Displayed in
the dashboard's **Artist lookup** (Track lookup tab → "Artist") via the shared badge grid
(`render_badge_chips(conn, artist_id, entity_type='artist')`).

The shared per-artist aggregate:

```sql
SELECT aid AS artist_id, COUNT(*) AS plays,
       COUNT(DISTINCT sp.track_uri) AS tracks, MIN(sp.played_at) AS first_played
FROM spotify_plays sp
JOIN track_metadata tm ON tm.track_uri = sp.track_uri
CROSS JOIN LATERAL unnest(tm.artist_ids) AS aid
WHERE sp.track_uri IS NOT NULL
GROUP BY aid
```

### Cumulative plays — `artist_plays_{100,250,500,1000,2500,5000}`
Single-fire. `plays >= n` on the aggregate above. Geometric pyramid (per the track-audit lesson).
**Trigger**: ingest cron (scoped to the batch's credited artists) / backfill. **Context**:
`{total_plays, distinct_tracks_played, first_played, basis}`.

### Distinct tracks — `artist_tracks_{5,15,30,50,100}`
Single-fire. `tracks >= n`. Breadth of catalogue explored (no track analog). **Context**:
`{distinct_tracks, cumulative_plays}`.

### Streaks — `artist_streak_{3,5,10}_years`
Single-fire. Gaps-and-islands over distinct calendar years per `artist_id` (≥1 play of ANY track
by the artist per year — the looser entry rule). A 3-year entry is added (artist streaks are
proportionally more common than track streaks). `awarded_at` = first play of the crossing year.
**Context**: `{consecutive_years, streak_start_year, streak_end_year}`.

### Rankings — `top_1st_artist_{month,season,year,alltime,decade}`
Multi-fire (`window` = period). The artist with the most in-period plays across a snapshot's
tracks (all-credited), via `compute_top_artist_from_snapshot`. **Trigger**: `create_snapshots.py`
at period end; backfill recomputes every completed period from `spotify_plays`. Podium (2nd/3rd)
is a **future extension** — v0.74 ships #1 only. `decade` = 0 until 2030.

### Dynasty — `dynasty`
Single-fire live state. An artist with **≥3 distinct tracks in the current all-time Top 100**.
**Trigger**: weekly cron end (`update_managed_playlists.py`), after the Top playlists refresh.
**Context**: `{tracks_in_alltime_top_100, count, basis}`.

### Rediscovery — `rediscovery`
Multi-fire (`window` = revival month). An artist with **prior ≥50 total plays** who went **≥12
consecutive months with 0 plays**, then returned with **≥20 plays in a single month**.
Deliberately not "comeback" — the workshop proved established-artist comeback doesn't exist in
this data (max prior 81 plays), so this looser framing catches minor-artist rediscoveries.
**Context**: `{window, plays, last_active, prior_total}`.

---

## Volume expectations (post-v0.67.1 backfill dry-run, 2026-07-03)

29,296 distinct tracks in `spotify_plays`. Multi-fire badge counts are **badge instances**
(a track can hold several), not distinct tracks — those rows are marked *(instances)*.

| Badge type | Backfill volume | % of catalog |
|---|---|---|
| plays_50 | 2703 | 9.2% |
| plays_100 | 604 | 2.1% |
| plays_200 | 124 | 0.42% |
| plays_300 | 60 | 0.20% |
| plays_400 | 34 | 0.12% |
| plays_500 | 20 | 0.068% |
| top_1st_month | 112 *(instances)* | — |
| top_1st_season | 37 *(instances)* | — |
| top_1st_year | 9 *(instances)* | — |
| top_1st_alltime | 0 | — |
| top_1st_decade | 0 | — |
| streak_5_years | 3570 | 12.2% |
| streak_8_years *(v0.74)* | 1633 | 5.6% |
| streak_10_years | 499 | 1.7% |
| plays_20_in_day | 841 *(instances)* | — |
| plays_40_in_day | 285 *(instances)* | — |
| plays_60_in_day *(v0.74)* | 146 *(instances)* | — |
| played_on_day_one | 5461 | 18.6% |
| day_one_fan | 266 | 0.91% |
| release_week_fan | 330 | 1.1% |
| late_bloomer *(v0.74 fix: 15 → 19)* | 19 | 0.065% |
| comeback | 20 *(instances)* | — |
| season_regular | 13 | 0.044% |
| multi_top | 23 | 0.078% |
| on_repeat *(v0.74)* | 53 | 0.18% |
| dominant *(v0.74)* | 2 | — |
| sovereign *(v0.74)* | 1 | — |

*top_1st_* / play-milestone counts are current `badge_events` rows; special-badge counts are the
v0.67.1 backfill dry-run (not yet applied to production at the time of writing). v0.74 counts are
its production backfill.*

### Artist badge volumes (v0.74 production backfill)

| Category | Volumes |
|---|---|
| Cumulative plays | 100→691, 250→360, 500→230, 1000→133, 2500→53, 5000→20 |
| Distinct tracks | 5→1316, 15→551, 30→330, 50→207, 100→86 |
| Streaks | 3y→1792, 5y→1207, 10y→434 |
| Rankings *(instances)* | month→112, season→38, year→9, alltime→1, decade→0 |
| Dynasty | 10 |
| Rediscovery *(instances)* | 2 |

## Change log

- **v0.63**: play milestone badges (plays_50…plays_500) + streaming milestone mails.
- **v0.65**: top_1st_* rankings badges + Rankings strip in mails; migration 0015 windowed unique
  index for multi-fire badges.
- **v0.67**: 10 special badges (streaks, daily intensity, release timing, behavioral) + Special
  strip in milestone mails. `multi_top` set to the broad-universe ≥10 threshold.
- **v0.67.1**: renamed `played_on_release_day` → `played_on_day_one`; renamed `day_one_stan` →
  `day_one_fan` and re-scoped it to ≥20 plays **on release day itself**; split out the new
  `release_week_fan` (≥50 plays in release week); tightened `late_bloomer` to require ≥30 plays
  within 90 days of first play. `detect_release_timing_at_50_plays` now returns a **list** of
  applicable badges. Total special badges: **11**; Special strip shows "N of 11 earned".
- **v0.68**: badge PNG icons (Defqon.1 hardstyle set) embedded into mails via CID.
- **v0.70**: Track-lookup badge grid ("Pokémon-doos") in the dashboard (`_badge_display.py`).
- **v0.74 — Track retuning + Artist badges arc.**
  - **Track (5 new + 1 fix)**: `late_bloomer` decoupled from the plays_50 gate (standalone
    `detect_late_bloomer_badges`, rescues 4 tracks, 15 → 19); `streak_8_years` (geometric-midpoint
    tier, 1633); `plays_60_in_day` (obsession tier, 146 instances); `on_repeat` (≥5 loop sessions
    of ≥10 consecutive plays, 53); `dominant` / `sovereign` (≥2 / ≥3 monthly #1s, 2 / 1). Total
    track special badges: **16**; the Special strip's "N of X earned" is computed from
    `len(SPECIAL_BADGE_TYPES)`. New Special-strip rows: Streaks 3 slots, Daily intensity 3 slots,
    Behavioral 4 slots, and a new "Rankings meta" row (dominant/sovereign).
  - **Artist (21 new)** — `lib/artist_badges.py`, `entity_type='artist'` (no migration): cumulative
    plays (6), distinct tracks (5), streaks 3/5/10y (3), rankings `top_1st_artist_*` (5, #1 only —
    podium deferred), Dynasty (1), Rediscovery (1). All-credited attribution; artist-streak entry
    rule = ≥1 play per year. Detection wired into the 30-min ingest (cumulative/distinct/streaks/
    rediscovery), daily snapshot (rankings), and weekly (Dynasty) crons; coalesced into the same
    ingest digest via an extended `BadgeAwardCollector`. Artist lookup added to the dashboard.
  - Backfills: `backfill_special_badges.py` extended; new `backfill_artist_badges.py` (bulk chunked
    inserts). Both idempotent, `--dry-run`, `send_mail=False`. Executed against production.
