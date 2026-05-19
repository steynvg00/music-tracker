# Spotify + Last.fm Music Tracker — Feature Specification

A personal tool to track, analyze, and manage Spotify listening using last.fm scrobble history and (later) Spotify Extended Streaming History.

---

## Project Overview

A cloud-hosted system that:

- Ingests scrobble history from last.fm (and later, Spotify Extended Streaming History)
- Automatically manages a set of structured Spotify playlists based on play counts and time periods
- Provides a personal statistics dashboard accessible from laptop and phone
- Allows manual playlist generation via custom rules or natural-language requests

---

## Architecture

| Layer           | Choice                                                          |
| --------------- | --------------------------------------------------------------- |
| Language        | Python 3.10+                                                    |
| Database        | PostgreSQL (free tier: Supabase or Neon)                        |
| Scheduler       | GitHub Actions cron (cloud-based, free)                         |
| Dashboard       | Streamlit, deployed to Streamlit Community Cloud                |
| Source control  | Single GitHub repo                                              |
| Auth            | Spotify OAuth (one-time refresh token stored as a secret)       |

**Rationale:** cloud-based so it runs regardless of laptop state. Phone access via the deployed Streamlit URL. Free tiers throughout.

---

## Data Sources

### Primary (initial): last.fm

- Full scrobble history via API
- Provides: track, artist, album, timestamp per scrobble
- Available immediately

### Future primary: Spotify Extended Streaming History

- Requested via Spotify account privacy settings (~30-day delivery)
- Covers full account lifetime (~2016 onward for this account)
- Richer than last.fm: millisecond timing, skip behavior, device, reason-ended
- Once delivered: becomes primary source for Spotify plays; last.fm becomes fallback for any non-Spotify listening

### Spotify Web API (always)

- Library, playlists, audio features, track metadata
- Write access for playlist creation and editing

### Pre-2016 (YouTube era)

- No scrobble data exists anywhere
- Estimation territory — handled separately, never blended with real data

### Key definition

**"Plays" = last.fm scrobbles** until Spotify Extended data arrives; then = Spotify plays (with last.fm as supplementary).

---

## Playlist Management

All playlists live in Spotify and are managed automatically by the system.

### Threshold playlists (updated weekly)

| Playlist        | Behavior                                                       |
| --------------- | -------------------------------------------------------------- |
| 20–49 plays     | **Exclusive** — tracks leave when they hit 50 plays            |
| 50+             | **Cumulative** — all tracks with ≥50 plays                     |
| 100+            | **Cumulative** — all tracks with ≥100 plays                    |
| 200+            | **Cumulative** — all tracks with ≥200 plays                    |
| 300+            | **Cumulative** — all tracks with ≥300 plays                    |
| 400+            | **Cumulative** — all tracks with ≥400 plays                    |
| 500+            | **Cumulative** — all tracks with ≥500 plays                    |

- Updated weekly via GitHub Actions
- Within each playlist: sorted by play count, descending
- Organized in a "Tops" folder in Spotify

### Monthly playlists (created at month close)

- **My Top 25 [Month] [Year]** — top 25 most-played tracks for that month. Filed in a folder named after the year (e.g. "2026").
- **My [Month] #1** — single track (the most-scrobbled track of that month).
- **My Monthly #1** — rolling playlist; grows by one track each month with that month's #1.

### Seasonal playlists

- **Seasonal Top 50** per season
- Seasons: **astronomical** (equinoxes and solstices, computed precisely each year)
  - Spring: ~Mar 20 → Jun 20/21
  - Summer: ~Jun 20/21 → Sep 22/23
  - Autumn: ~Sep 22/23 → Dec 21/22
  - Winter: ~Dec 21/22 → Mar 20

### Yearly playlists

- **Yearly Top 100** — top 100 scrobbled tracks of that calendar year, locked at year-end.

### Decadal playlists

- **Decadely Top 100** — top 100 across a calendar decade (e.g. 2020–2029).

### All-time playlists

- **All-Time Top 100** — yearly snapshot. New playlist each year (e.g. "All-Time Top 100 — 2026"). Previous years' snapshots preserved.

### Recently Added Tracks

- User manually adds tracks to this playlist
- System trims when it exceeds 150: removes the 5 oldest entries whenever the count reaches 155
- **Future option (deferred):** auto-add tracks to this playlist when added to Liked Songs

### Spotify folder structure (initial)

- `Tops/` — threshold playlists
- `Years/` — yearly + per-year subfolders containing monthly Top 25s
- Other groupings TBD during build

---

## Statistics & Dashboard

All stats filterable by **time scale**: week / month / year(s) / all-time (user-switchable).

### Listening patterns

- Listening heatmap (hour-of-day × day-of-week)
- Session analysis (length, frequency, binge vs graze)
- Time-of-day artist fingerprints (morning vs night artists)
- Loop counter (tracks played 5+ times back-to-back)
- Listening velocity (rolling minutes/day average)

### Track lifecycles

- Slow burns vs instant hits
- Half-life (peaked early then died vs sustained love)
- Saved-but-skipped (in library, low play count)
- Days-to-100 (fastest climbers)
- **Top 10 artist battle chart** over time (changeable time scale: week / month / year / all-time; retrospective)

### Artist relationships

- Gateway moment (first scrobble date for each top artist)
- Artist lifecycle (discovery → peak → current state)
- Loyalty index (% of scrobbles to top 20 artists)
- Co-listening clusters (artists appearing in the same sessions)
- Artist retirement (once top-20, dormant 12+ months)

### Genre & diversity

- Genre evolution (stacked area chart over time)
- Variety index (distinct artists per 100 scrobbles)
- New vs repeat ratio per period

### Albums

- Album binge detection (full albums played in order)
- Album favoritism (top track vs rest of album)
- Album completeness (% of discography scrobbled per top artist)

### Playlist analysis

- Pie / circle chart of artist composition per playlist (shown when viewing any playlist's stats)
- Applies to both custom and Spotify-generated playlists

### Milestones & totals

- Lifetime totals (scrobbles, hours, biggest single day)
- Milestone alerts (50k scrobbles, artist hits 1,000 plays, etc.)
- Discovery rate (new artists per month)
- Streaks (consecutive listening days, longest single-track repeat)
- Year-in-review (on-demand Wrapped, more detailed)
- Period comparisons (this month vs last, this year vs last)

### Predictive

- "On track to be a top track" — pace extrapolation
- Predicted next month's #1

### Advanced visualizations

- **Sankey** — track flow between threshold tiers over time
- **Treemap** — artists / albums / tracks by play count
- **Force-directed graph** — artist clusters by co-listening (constellation map of your taste)

---

## Creative Bonus Features (later phase)

Nice-to-haves to add later, with the option to disable any that don't earn their keep.

- **On this day** — surfaces what you were obsessing over exactly 1/2/3 years ago today
- **Listening calendar** — GitHub-style contribution heatmap of daily listening
- **Bar chart race** — animated top-10 artists evolving over years
- **Concert overlay** — log concerts attended; analyze before/after impact on play counts
- **Listening fingerprint** — generative poster from your data, refreshed yearly
- **Audio-feature personality** — your position on global tempo/energy/valence distributions
- **Hidden gems detector** — old 1–2 play tracks matching current taste, worth revisiting
- ⭐ **Skip analysis** (high interest — blocked on Spotify Extended arrival)
  - Completion rate per track / per artist
  - Skip-and-save paradox (saved tracks frequently skipped)
  - Where within tracks you skip (intros, outros, bridges)
  - Skip-mood detection (periods of heavy skipping)
- **Lyric word cloud** — themes dominating your top tracks (needs lyrics API)
- **You vs Past-You** — abandoned, surviving, and grown-into tracks since a chosen year
- **Album top-to-bottom score** — cherry-picker vs deep-diver per album
- **Weekend brain vs weekday brain** — separate listening profiles
- **Achievements** — opt-in badges ("first 500-play track," etc.)

---

## Utilities

- **Scrobble gap detection** — flag suspicious silences in scrobble history
- **Metadata reconciliation** — handle artist-name mismatches between last.fm and Spotify ("Artist & Artist" vs "Artist, Artist")
- **Playlist auditing** — find duplicates across playlists, catch tracks in tier playlists that no longer belong

---

## Deferred / Experimental Features

To test or build later, willing to disable if not satisfying:

- **Anniversary playlists** — kept as maybe; could complement Top 25s with moment-based angle ("today is one year since X cracked your top 10")
- **Audio-feature playlists** — use audio features as *filters* on rule-based playlists rather than as foundations. E.g. "All-Time Top 100 ≥120 BPM." Reliable on mechanical attributes (tempo, energy, valence-extremes); patchy on vibe.
- **Smart shuffle** — recency-weighted shuffle: probability inversely tied to recent plays. Built-in rotation.
- **Natural-language playlist requests** — translate "a 90-minute playlist of upbeat 2010s tracks I haven't heard this year" into SQL-style filters against the database. Feasible since data is structured.
- **Auto-add to Recently Added** when a track is added to Liked Songs

---

## Rejected Features

- First-discovered-per-month playlists
- Social / friend comparison features (strictly personal tool)

---

## Pre-2016 Play Count Estimation (final-phase feature)

A method for estimating play counts for tracks loved before scrobble data exists.

### The fundamental problem

Listening curves follow: ramp → peak → decay → long flat tail. The tail carries almost no information about peak height. A track playing 4×/year now could have peaked at 30 plays/year or 300 plays/year. The data does not distinguish them.

### Approach

1. **Anchor with metadata** — track release date constrains when peak could have happened.
2. **Reference-class extrapolation** — cluster post-scrobble lifecycle curves by shape; match each pre-data track to its best cluster; apply that cluster's peak-to-tail ratio.
3. **Self-rating** — user rates pre-2016 favorites in tiers (casual / liked / loved / anthem / obsession), optionally via pairwise comparisons. Tiers calibrated against post-2016 tracks rated the same.
4. **Bayesian combination** — combine release date × reference class × self-rating × observed tail. Output a **range**, not a point estimate.

### Presentation rules

- Never blur estimated and verified data
- Verified plays remain the basis for threshold playlists and "real" top-100s
- Estimates appear only in a separate parallel "best-guess all-time" view with visible uncertainty bands
- Honest wide error bars > false narrow confidence

### Gap definition

Once Spotify Extended Streaming History arrives (account-lifetime data, ~2016 onward):

- **2016–2019:** filled by Spotify Extended (real data, not estimate)
- **2019–now:** dual-sourced (Spotify Extended + last.fm, cross-validated)
- **Pre-2016 (YouTube era):** the only true estimation gap

---

## Setup Checklist (when ready to build)

- [ ] Spotify Developer app (developer.spotify.com/dashboard)
  - Redirect URI: `http://127.0.0.1:8888/callback` for dev; production URI added later
  - Save Client ID and Client Secret
- [ ] last.fm API key (last.fm/api/account/create)
- [ ] last.fm username confirmed
- [ ] GitHub account
- [ ] Supabase or Neon account (free Postgres)
- [ ] Python 3.10+ installed
- [ ] Code editor (VS Code recommended)
- [ ] Spotify Extended Streaming History data request submitted (30-day wait)
- [ ] Local project folder created

---

## Suggested Build Phases

### Phase 1 — MVP

- Data ingestion from last.fm
- Postgres schema
- Threshold playlists (weekly updates)
- Monthly Top 25 + Monthly #1
- Recently Added Tracks trimmer
- Basic Streamlit dashboard with core stats
- GitHub Actions cron set up

### Phase 2 — Full automation + stats

- Seasonal / yearly / decadal / all-time snapshot playlists
- Complete statistics dashboard (all listed stats)
- Pie chart playlist composition view
- Utilities (gap detection, reconciliation, auditing)

### Phase 3 — Spotify Extended integration

- Ingest Spotify Extended Streaming History on delivery
- Cross-validate with last.fm
- Backfill 2016–2019 data
- ⭐ **Skip analysis** suite (high priority for this phase)

### Phase 4 — Creative bonus features

- On this day, listening calendar, bar chart race, concert overlay, etc.
- Implement, evaluate, disable any that don't earn their keep

### Phase 5 — Experimental / deferred

- Audio-feature filtering on existing playlists
- Smart shuffle (recency-weighted)
- Natural-language playlist requests
- Anniversary playlists (test if not redundant with monthly tops)

### Phase 6 — Pre-2016 estimation

- Self-rating interface (with pairwise comparison mode)
- Reference-class clustering of lifecycle curves
- Bayesian estimation engine with uncertainty bands
- Separate "best-guess all-time" view

---

## Open Questions / Decisions Pending

- Exact Spotify folder organization (Tops/, Years/, plus others?)
- Lyrics API choice for lyric-based features (Musixmatch, Genius, etc.) — Phase 4
- Specific schedule cadences (day of week for weekly run, time of day)
- Concert API for the concert overlay feature (Bandsintown, Songkick) — Phase 4
- Production redirect URI for Spotify OAuth (set when deploying to Streamlit Cloud)

---

## Context Notes for Future Reference

- User location: Netherlands
- User's scrobble history begins: ~2019
- Spotify account created: ~2016
- Pre-2016 listening: primarily YouTube (no recoverable data)
- Coding background: basic Python, will follow guidance step by step
- Preferred run model: cloud (auto-runs without laptop on), accessed via Streamlit on laptop and phone
- User is **not** ready to start building yet — feature definition phase complete, build phase to follow when ready
