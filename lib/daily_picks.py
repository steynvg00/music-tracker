"""Daily pick generator (v0.81, R1): five candidates per Europe/Amsterdam day.

Writes daily_pick_candidates (migration 0021). The Rotor hub only reads them: Rotate
moves a pointer, Play writes a generated pick into 'Daily pick · Auto 🤖🔄' through the
hub's write guard, or plays an existing playlist as-is (read + play only).

Two kinds of candidate, interleaved G E G E G:

* generated — a recipe over your own history (no Spotify recommendations, which
  Development Mode apps don't get):
    forgotten_gems      liked, ≥ 20 plays, not heard for ≥ 180 days
    evergreen_core      evergreen_pct ≥ 0.8, not heard for ≥ 21 days
    fresh_heat          most-played of the last 14 days + unplayed Missed new tracks
    artist_deep_dive    one top-50 artist, tracks you played fewer than 3 times
    discovered_in_year  tracks first heard in year Y (Y not used in the last 7 days)
  Three recipes per day, rotating through the list one step per day.

* existing_playlist — one of your Spotify playlists from the mirror, ranked by
    rotation_score = 0.5·norm(days since suggested) + 0.3·(1 − coverage_60d) + 0.2·affinity
  coverage_60d (share of its tracks heard in the last 60 days) and affinity (mean
  composite_score of its tracks) only exist for playlists whose items we can read;
  followed playlists get a neutral 0.5 for both.

Everything is deterministic per (date, reseed): re-running the generator for a day gives
the same deck. All the selection logic is pure Python over one stats load, so it is
unit-tested without a database (tests/test_daily_picks.py).
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Iterable
from zoneinfo import ZoneInfo

from lib.playlist_mirror import MISSED_NEW_PREFIX

TZ = ZoneInfo("Europe/Amsterdam")

DECK_SIZE = 5
DECK_PATTERN = ("generated", "existing", "generated", "existing", "generated")
TARGET_DURATION_MS = 75 * 60 * 1000   # open question 5 (06-roadmap.md): ~75 min per pick
MIN_TRACKS = 8
MAX_TRACKS = 100                       # one PUT /playlists/{id}/items call
DEFAULT_TRACK_MS = 210_000             # when track_metadata has no duration

# Rotation pool (open question 6). Tune here.
INCLUDE_SNAPSHOTS = True               # old snapshots like "Top 25 · March 2021 · Auto 🤖📸"
INCLUDE_SPOTIFY_OWNED = False          # unverified playback (R1 spike d); flip after the spike
EXCLUDED_PLAYLIST_NAMES = frozenset({"Recently Added Tracks"})
MIN_PLAYLIST_TRACKS = 5
SUGGEST_COOLDOWN_DAYS = 30             # shown as the current pick → not again for 30 days
CANDIDATE_COOLDOWN_DAYS = 7            # listed in a deck → not in another deck for 7 days
PARAM_COOLDOWN_DAYS = {"artist_deep_dive": 14, "discovered_in_year": 7}

RECIPE_ORDER = (
    "forgotten_gems",
    "evergreen_core",
    "fresh_heat",
    "artist_deep_dive",
    "discovered_in_year",
)
GENERATED_PER_DECK = 3
PARAM_RECIPES = frozenset({"artist_deep_dive", "discovered_in_year"})  # new params → new tracks


def today_local(now: datetime | None = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(TZ).date()


# ── Data shapes ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TrackStat:
    uri: str
    name: str | None
    artist: str | None
    artists: tuple[str, ...] = ()
    plays: int = 0
    plays_14d: int = 0
    plays_60d: int = 0
    first_played: datetime | None = None
    last_played: datetime | None = None
    liked: bool = False
    duration_ms: int | None = None
    evergreen_pct: float | None = None
    composite: float | None = None

    @property
    def length_ms(self) -> int:
        return self.duration_ms or DEFAULT_TRACK_MS


@dataclass(frozen=True)
class PoolPlaylist:
    playlist_id: str
    name: str
    owner_id: str
    is_owned: bool
    is_collab: bool
    managed_kind: str | None
    track_count: int | None
    last_suggested_on: date | None = None
    item_uris: tuple[str, ...] | None = None   # None = items not readable / not mirrored


@dataclass
class Candidate:
    kind: str                       # 'generated' | 'existing_playlist'
    title: str
    reason: str
    recipe: str | None = None
    params: dict = field(default_factory=dict)
    playlist_id: str | None = None
    track_uris: list[str] | None = None
    duration_ms: int | None = None
    score: float | None = None


@dataclass
class Context:
    today: date
    now: datetime
    rng: random.Random
    tracks: list[TrackStat]
    missed_new: list[TrackStat] = field(default_factory=list)   # unplayed, from the mirror
    top_artists: list[str] = field(default_factory=list)
    recent: list[dict] = field(default_factory=list)            # earlier decks: {pick_date, recipe, params, playlist_id}
    deck_so_far: list[dict] = field(default_factory=list)       # today's existing ranks (reseed)
    by_uri: dict[str, TrackStat] = field(default_factory=dict)

    def __post_init__(self):
        if not self.by_uri:
            self.by_uri = {t.uri: t for t in self.tracks}

    def recent_params(self, recipe: str, key: str) -> set:
        days = PARAM_COOLDOWN_DAYS.get(recipe, 7)
        since = self.today - timedelta(days=days)
        out = {
            (r.get("params") or {}).get(key)
            for r in self.recent
            if r.get("recipe") == recipe and r["pick_date"] >= since
        }
        out |= {(r.get("params") or {}).get(key) for r in self.deck_so_far if r.get("recipe") == recipe}
        out.discard(None)
        return out


# ── Helpers ──────────────────────────────────────────────────────────────────

def seeded_rng(day: date, reseed: int = 0) -> random.Random:
    return random.Random(f"rotor-daily:{day.isoformat()}:{reseed}")


def weighted_order(rng: random.Random, items: Iterable, weight: Callable) -> list:
    """Weighted random order without replacement (Efraimidis–Spirakis)."""
    keyed = []
    for it in items:
        w = max(float(weight(it)), 1e-6)
        keyed.append((rng.random() ** (1.0 / w), it))
    keyed.sort(key=lambda kv: kv[0], reverse=True)
    return [it for _, it in keyed]


def fill_to_duration(
    ordered: Iterable[TrackStat],
    target_ms: int = TARGET_DURATION_MS,
    min_tracks: int = MIN_TRACKS,
    max_tracks: int = MAX_TRACKS,
) -> list[TrackStat] | None:
    """Take tracks in order until the target length is reached. Skips duplicate
    recordings (same title + artist under another URI). None if too few tracks."""
    picked: list[TrackStat] = []
    seen: set[tuple[str, str]] = set()
    total = 0
    for t in ordered:
        sig = ((t.name or t.uri).casefold(), (t.artist or "").casefold())
        if sig in seen:
            continue
        seen.add(sig)
        picked.append(t)
        total += t.length_ms
        if total >= target_ms or len(picked) >= max_tracks:
            break
    return picked if len(picked) >= min_tracks else None


def format_duration(ms: int) -> str:
    minutes = round(ms / 60000)
    h, m = divmod(minutes, 60)
    return f"{h} h {m} min" if h else f"{m} min"


def _generated(recipe: str, title: str, reason: str, picked: list[TrackStat], rng: random.Random,
               params: dict | None = None, shuffle: bool = True) -> Candidate:
    tracks = list(picked)
    if shuffle:
        rng.shuffle(tracks)
    return Candidate(
        kind="generated",
        recipe=recipe,
        title=title,
        reason=reason,
        params=params or {},
        track_uris=[t.uri for t in tracks],
        duration_ms=sum(t.length_ms for t in tracks),
    )


# ── Recipes ──────────────────────────────────────────────────────────────────

def recipe_forgotten_gems(ctx: Context) -> Candidate | None:
    cutoff = ctx.now - timedelta(days=180)
    pool = [t for t in ctx.tracks
            if t.liked and t.plays >= 20 and t.last_played and t.last_played <= cutoff]
    picked = fill_to_duration(weighted_order(ctx.rng, pool, lambda t: t.plays))
    if not picked:
        return None
    return _generated("forgotten_gems", "Forgotten gems",
                      f"{len(picked)} liked tracks you haven't played in 6+ months", picked, ctx.rng)


def recipe_evergreen_core(ctx: Context) -> Candidate | None:
    cutoff = ctx.now - timedelta(days=21)
    pool = [t for t in ctx.tracks
            if (t.evergreen_pct or 0) >= 0.8 and t.last_played and t.last_played <= cutoff]
    picked = fill_to_duration(weighted_order(ctx.rng, pool, lambda t: (t.composite or 0.1) + 0.05))
    if not picked:
        return None
    return _generated("evergreen_core", "Evergreen core",
                      f"{len(picked)} tracks that never get old, rested for 3+ weeks", picked, ctx.rng)


def recipe_fresh_heat(ctx: Context) -> Candidate | None:
    hot = sorted((t for t in ctx.tracks if t.plays_14d >= 2),
                 key=lambda t: (-t.plays_14d, t.uri))
    hot_part = fill_to_duration(hot, target_ms=int(TARGET_DURATION_MS * 0.6), min_tracks=1) or []
    new_order = weighted_order(ctx.rng, ctx.missed_new, lambda t: 1.0)
    remaining = TARGET_DURATION_MS - sum(t.length_ms for t in hot_part)
    new_part = fill_to_duration(new_order, target_ms=max(remaining, 0), min_tracks=0) or []
    if not new_part and remaining > 0:  # no new releases: let the hot list run longer
        hot_part = fill_to_duration(hot, min_tracks=1) or []
    # Alternate hot / new so the new releases are spread through the pick.
    mixed: list[TrackStat] = []
    for i in range(max(len(hot_part), len(new_part))):
        if i < len(hot_part):
            mixed.append(hot_part[i])
        if i < len(new_part):
            mixed.append(new_part[i])
    picked = fill_to_duration(mixed, target_ms=10**12)  # dedupe + min check only
    if not picked:
        return None
    n_hot = sum(1 for t in picked if t in hot_part)
    n_new = len(picked) - n_hot
    reason = f"Your {n_hot} most-played of the last 14 days"
    if n_new:
        reason += f" + {n_new} new releases you haven't heard"
    return _generated("fresh_heat", "Fresh heat", reason, picked, ctx.rng, shuffle=False)


def _matches_artist(t: TrackStat, artist: str) -> bool:
    a = artist.casefold()
    return (t.artist or "").casefold() == a or any(x.casefold() == a for x in t.artists)


def recipe_artist_deep_dive(ctx: Context) -> Candidate | None:
    blocked = {a.casefold() for a in ctx.recent_params("artist_deep_dive", "artist")}
    artists = [a for a in ctx.top_artists if a and a.casefold() not in blocked]
    ctx.rng.shuffle(artists)
    for artist in artists:
        pool = [t for t in ctx.tracks if t.plays < 3 and _matches_artist(t, artist)]
        ordered = weighted_order(ctx.rng, pool, lambda t: 3.0 if t.liked else 1.0)
        picked = fill_to_duration(ordered)
        if picked:
            return _generated(
                "artist_deep_dive", f"Deep dive: {artist}",
                f"{len(picked)} {artist} tracks you've played fewer than 3 times",
                picked, ctx.rng, params={"artist": artist},
            )
    return None


def recipe_discovered_in_year(ctx: Context) -> Candidate | None:
    by_year: dict[int, list[TrackStat]] = {}
    for t in ctx.tracks:
        if t.first_played and (t.liked or t.plays >= 5):
            by_year.setdefault(t.first_played.astimezone(TZ).year, []).append(t)
    blocked = ctx.recent_params("discovered_in_year", "year")
    years = sorted(y for y, ts in by_year.items()
                   if y != ctx.today.year and y not in blocked and len(ts) >= 2 * MIN_TRACKS)
    if not years:
        return None
    year = ctx.rng.choice(years)
    picked = fill_to_duration(weighted_order(ctx.rng, by_year[year], lambda t: t.plays))
    if not picked:
        return None
    return _generated("discovered_in_year", f"Discovered in {year}",
                      f"{len(picked)} tracks you first heard in {year}",
                      picked, ctx.rng, params={"year": year})


RECIPES: dict[str, Callable[[Context], Candidate | None]] = {
    "forgotten_gems": recipe_forgotten_gems,
    "evergreen_core": recipe_evergreen_core,
    "fresh_heat": recipe_fresh_heat,
    "artist_deep_dive": recipe_artist_deep_dive,
    "discovered_in_year": recipe_discovered_in_year,
}


def recipe_cycle(day: date, reseed: int = 0) -> list[str]:
    """All recipes, starting at the day's offset (one step per day; a reseed shifts by 3
    so "Shuffle the deck" leads with the recipes today's first deck didn't use)."""
    start = (day.toordinal() + GENERATED_PER_DECK * reseed) % len(RECIPE_ORDER)
    return [RECIPE_ORDER[(start + i) % len(RECIPE_ORDER)] for i in range(len(RECIPE_ORDER))]


# ── Existing playlists ───────────────────────────────────────────────────────

def in_pool(p: PoolPlaylist) -> bool:
    """Static rotation-pool membership (no cooldowns)."""
    if p.name in EXCLUDED_PLAYLIST_NAMES:
        return False
    if p.managed_kind not in (None, "auto_snapshot"):
        return False  # auto-updating (Top 100s every day) and custom playlists stay out
    if p.managed_kind == "auto_snapshot" and not INCLUDE_SNAPSHOTS:
        return False
    if p.owner_id == "spotify" and not INCLUDE_SPOTIFY_OWNED:
        return False
    if p.track_count is not None and p.track_count < MIN_PLAYLIST_TRACKS:
        return False
    return True


def eligible(p: PoolPlaylist, ctx: Context) -> bool:
    """In the pool and out of every cooldown."""
    if not in_pool(p):
        return False
    if p.last_suggested_on and (ctx.today - p.last_suggested_on).days < SUGGEST_COOLDOWN_DAYS:
        return False
    since = ctx.today - timedelta(days=CANDIDATE_COOLDOWN_DAYS)
    if any(r.get("playlist_id") == p.playlist_id and r["pick_date"] >= since for r in ctx.recent):
        return False
    if any(r.get("playlist_id") == p.playlist_id for r in ctx.deck_so_far):
        return False
    return True


def rotation_score(p: PoolPlaylist, ctx: Context) -> tuple[float, float | None]:
    """(score, coverage_60d). Coverage is None for playlists whose items we can't read."""
    days = (ctx.today - p.last_suggested_on).days if p.last_suggested_on else 365
    days_norm = min(max(days, 0), 365) / 365
    coverage: float | None = None
    affinity = 0.5
    if p.item_uris:
        uniq = set(p.item_uris)
        heard = sum(1 for u in uniq if (s := ctx.by_uri.get(u)) and s.plays_60d > 0)
        coverage = heard / len(uniq)
        comps = [s.composite for u in uniq if (s := ctx.by_uri.get(u)) and s.composite is not None]
        if comps:
            affinity = min(max(sum(comps) / len(comps), 0.0), 1.0)
    cov = 0.5 if coverage is None else coverage
    return round(0.5 * days_norm + 0.3 * (1 - cov) + 0.2 * affinity, 4), coverage


def existing_reason(p: PoolPlaylist, ctx: Context, coverage: float | None) -> str:
    if p.last_suggested_on:
        parts = [f"Last suggested {(ctx.today - p.last_suggested_on).days} days ago"]
    else:
        parts = ["Not suggested by Rotor yet"]
    if coverage is not None:
        parts.append(f"{round(coverage * 100)}% of it heard in the last 60 days")
    elif not (p.is_owned or p.is_collab):
        parts.append("followed playlist, play only")
    return " · ".join(parts)


def score_pool(pool: list[PoolPlaylist], ctx: Context) -> dict[str, float]:
    """rotation_score for every pool playlist; stored so Home can show "Coming back around"."""
    return {p.playlist_id: rotation_score(p, ctx)[0] for p in pool if in_pool(p)}


def pick_existing(pool: list[PoolPlaylist], ctx: Context, k: int) -> list[Candidate]:
    scored = []
    for p in pool:
        if not eligible(p, ctx):
            continue
        score, coverage = rotation_score(p, ctx)
        jitter = ctx.rng.uniform(0, 0.03)  # breaks ties differently per day
        scored.append((score + jitter, score, coverage, p))
    scored.sort(key=lambda s: (-s[0], s[3].playlist_id))
    return [
        Candidate(kind="existing_playlist", title=p.name, reason=existing_reason(p, ctx, cov),
                  playlist_id=p.playlist_id, score=score)
        for _, score, cov, p in scored[:k]
    ]


# ── Deck ─────────────────────────────────────────────────────────────────────

def build_deck(ctx: Context, pool: list[PoolPlaylist], reseed: int = 0) -> list[Candidate]:
    # A reseed never repeats a recipe without parameters (same day → near-identical
    # tracks). A shorter deck beats a duplicate.
    used_today = {r.get("recipe") for r in ctx.deck_so_far} - PARAM_RECIPES
    generated: list[Candidate] = []
    for name in recipe_cycle(ctx.today, reseed):
        if name in used_today:
            continue
        c = RECIPES[name](ctx)
        if c:
            generated.append(c)
            ctx.deck_so_far.append({"recipe": c.recipe, "params": c.params})
    existing = pick_existing(pool, ctx, DECK_SIZE)

    lists = {"generated": generated, "existing": existing}
    deck: list[Candidate] = []
    for slot in DECK_PATTERN:
        other = "existing" if slot == "generated" else "generated"
        source = lists[slot] if lists[slot] else lists[other]
        if source:
            deck.append(source.pop(0))
    return deck


# ── Database I/O ─────────────────────────────────────────────────────────────

_TRACK_STATS_SQL = """
WITH s AS (
    SELECT track_uri,
           count(*)                                                        AS plays,
           count(*) FILTER (WHERE played_at >= now() - interval '14 days') AS plays_14d,
           count(*) FILTER (WHERE played_at >= now() - interval '60 days') AS plays_60d,
           min(played_at)                                                  AS first_played,
           max(played_at)                                                  AS last_played,
           max(track_name)                                                 AS track_name,
           max(artist_name)                                                AS artist_name
    FROM spotify_plays
    WHERE track_uri IS NOT NULL
    GROUP BY track_uri
), u AS (
    SELECT track_uri FROM s
    UNION
    SELECT track_uri FROM liked_songs
)
SELECT u.track_uri,
       coalesce(s.track_name, ls.track_name),
       coalesce(s.artist_name, ls.artist_name),
       tm.artist_names,
       coalesce(s.plays, 0), coalesce(s.plays_14d, 0), coalesce(s.plays_60d, 0),
       s.first_played, s.last_played,
       ls.track_uri IS NOT NULL,
       tm.duration_ms,
       tps.evergreen_pct,
       tps.composite_score
FROM u
LEFT JOIN s                       USING (track_uri)
LEFT JOIN liked_songs ls          USING (track_uri)
LEFT JOIN track_metadata tm       USING (track_uri)
LEFT JOIN track_popularity_scores tps USING (track_uri)
WHERE u.track_uri LIKE 'spotify:track:%'
"""

_MISSED_NEW_SQL = """
SELECT DISTINCT ON (i.track_uri) i.track_uri, i.track_name, i.artist_name, i.duration_ms
FROM spotify_playlist_items i
JOIN spotify_playlists p USING (playlist_id)
WHERE p.removed_at IS NULL
  AND p.is_owned
  AND p.managed_kind = 'auto_updating'
  AND p.name LIKE %s
  AND i.track_uri LIKE 'spotify:track:%%'
  AND NOT EXISTS (SELECT 1 FROM spotify_plays sp WHERE sp.track_uri = i.track_uri)
ORDER BY i.track_uri
"""


def _f(v) -> float | None:
    return None if v is None else float(v)


def load_tracks(conn) -> list[TrackStat]:
    cur = conn.cursor()
    cur.execute(_TRACK_STATS_SQL)
    return [
        TrackStat(uri=r[0], name=r[1], artist=r[2], artists=tuple(r[3] or ()),
                  plays=r[4], plays_14d=r[5], plays_60d=r[6], first_played=r[7], last_played=r[8],
                  liked=bool(r[9]), duration_ms=r[10], evergreen_pct=_f(r[11]), composite=_f(r[12]))
        for r in cur.fetchall()
    ]


def load_missed_new(conn) -> list[TrackStat]:
    cur = conn.cursor()
    cur.execute(_MISSED_NEW_SQL, (MISSED_NEW_PREFIX + "%",))
    return [TrackStat(uri=r[0], name=r[1], artist=r[2], duration_ms=r[3]) for r in cur.fetchall()]


def load_top_artists(conn, limit: int = 50) -> list[str]:
    cur = conn.cursor()
    cur.execute(
        "SELECT artist_name FROM artist_popularity_scores ORDER BY composite_score DESC LIMIT %s",
        (limit,),
    )
    return [r[0] for r in cur.fetchall()]


def load_pool(conn) -> list[PoolPlaylist]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT p.playlist_id, p.name, p.owner_id, p.is_owned, p.is_collab, p.managed_kind,
               p.track_count, h.last_suggested_on, p.items_snapshot_id IS NOT NULL
        FROM spotify_playlists p
        LEFT JOIN playlist_rotation_history h USING (playlist_id)
        WHERE p.removed_at IS NULL
        """
    )
    rows = cur.fetchall()
    with_items = [r[0] for r in rows if r[8]]
    items: dict[str, list[str]] = {}
    if with_items:
        cur.execute(
            "SELECT playlist_id, track_uri FROM spotify_playlist_items WHERE playlist_id = ANY(%s)",
            (with_items,),
        )
        for pid, uri in cur.fetchall():
            items.setdefault(pid, []).append(uri)
    return [
        PoolPlaylist(playlist_id=r[0], name=r[1], owner_id=r[2], is_owned=r[3], is_collab=r[4],
                     managed_kind=r[5], track_count=r[6], last_suggested_on=r[7],
                     item_uris=tuple(items.get(r[0], ())) if r[8] else None)
        for r in rows
    ]


def load_recent(conn, day: date, days: int = 14) -> list[dict]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT pick_date, rank, recipe, params, playlist_id
        FROM daily_pick_candidates
        WHERE pick_date >= %s AND pick_date <= %s
        """,
        (day - timedelta(days=days), day),
    )
    return [{"pick_date": r[0], "rank": r[1], "recipe": r[2], "params": r[3] or {}, "playlist_id": r[4]}
            for r in cur.fetchall()]


def load_state(conn, day: date) -> dict | None:
    cur = conn.cursor()
    cur.execute(
        "SELECT current_rank, played_rank, rotated FROM daily_pick_state WHERE pick_date = %s",
        (day,),
    )
    r = cur.fetchone()
    return None if r is None else {"current_rank": r[0], "played_rank": r[1], "rotated": list(r[2] or [])}


def write_deck(conn, day: date, deck: list[Candidate], start_rank: int,
               pool_scores: dict[str, float], reseed: bool) -> None:
    cur = conn.cursor()
    for i, c in enumerate(deck):
        cur.execute(
            """
            INSERT INTO daily_pick_candidates
                (pick_date, rank, kind, recipe, params, playlist_id, title, reason,
                 track_uris, duration_ms, score)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s)
            """,
            (day, start_rank + i, c.kind, c.recipe, json.dumps(c.params), c.playlist_id, c.title,
             c.reason, c.track_uris, c.duration_ms, c.score),
        )
    if reseed:
        # Show the first new candidate right away; clears the hub's "Mixing new picks…".
        cur.execute(
            """
            INSERT INTO daily_pick_state (pick_date, current_rank) VALUES (%s, %s)
            ON CONFLICT (pick_date) DO UPDATE
               SET current_rank = EXCLUDED.current_rank, reseed_requested_at = NULL, updated_at = now()
            """,
            (day, start_rank),
        )
    else:
        cur.execute(
            "INSERT INTO daily_pick_state (pick_date, current_rank) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (day, start_rank),
        )
    if pool_scores:
        cur.executemany(
            """
            INSERT INTO playlist_rotation_history (playlist_id, rotation_score, scored_at)
            VALUES (%s, %s, now())
            ON CONFLICT (playlist_id) DO UPDATE
               SET rotation_score = EXCLUDED.rotation_score, scored_at = EXCLUDED.scored_at
            """,
            sorted(pool_scores.items()),
        )
    conn.commit()


@dataclass
class GenerateResult:
    day: date
    status: str                     # 'generated' | 'reseeded' | 'exists' | 'empty'
    deck: list[Candidate] = field(default_factory=list)
    start_rank: int = 1


def generate(conn, day: date, *, reseed: bool = False, force: bool = False,
             dry_run: bool = False, now: datetime | None = None) -> GenerateResult:
    now = now or datetime.now(timezone.utc)
    recent_all = load_recent(conn, day)
    today_rows = [r for r in recent_all if r["pick_date"] == day]
    recent = [r for r in recent_all if r["pick_date"] < day]

    if today_rows and not reseed:
        if not force:
            return GenerateResult(day, "exists")
        state = load_state(conn, day)
        if state and (state["played_rank"] is not None or state["rotated"]):
            raise RuntimeError(f"{day}: the deck was already played or rotated; use --reseed instead of --force")
        if not dry_run:
            cur = conn.cursor()
            cur.execute("DELETE FROM daily_pick_state WHERE pick_date = %s", (day,))
            cur.execute("DELETE FROM daily_pick_candidates WHERE pick_date = %s", (day,))
            conn.commit()
        today_rows = []

    reseed_n = (max(r["rank"] for r in today_rows) - 1) // DECK_SIZE + 1 if (reseed and today_rows) else 0
    start_rank = max((r["rank"] for r in today_rows), default=0) + 1

    tracks = load_tracks(conn)
    ctx = Context(
        today=day, now=now, rng=seeded_rng(day, reseed_n), tracks=tracks,
        missed_new=load_missed_new(conn), top_artists=load_top_artists(conn),
        recent=recent, deck_so_far=list(today_rows),
    )
    pool = load_pool(conn)
    deck = build_deck(ctx, pool, reseed=reseed_n)
    if not deck:
        return GenerateResult(day, "empty")
    if not dry_run:
        write_deck(conn, day, deck, start_rank, score_pool(pool, ctx), reseed=bool(today_rows))
    return GenerateResult(day, "reseeded" if today_rows else "generated", deck, start_rank)
