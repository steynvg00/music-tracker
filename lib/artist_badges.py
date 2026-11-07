"""Artist badge detection + notifications (v0.74).

Mirrors the track badge system (lib/badges.py) but keyed on Spotify artist_id
(entity_type='artist' — badge_events already permits it, migration 0014 CHECK, so no
schema change). 21 badge types across 6 categories, per docs/artist_badge_workshop.md:

  Cumulative plays  artist_plays_{100,250,500,1000,2500,5000}   (6, single-fire)
  Distinct tracks   artist_tracks_{5,15,30,50,100}              (5, single-fire)
  Streaks           artist_streak_{3,5,10}_years                (3, single-fire)
  Rankings          top_1st_artist_{month,season,year,alltime,decade}  (5, multi-fire)
  Dynasty           dynasty  (≥3 tracks in all-time Top 100)     (1, single-fire)
  Rediscovery       rediscovery (prior ≥50 → 12mo silent → ≥20) (1, multi-fire)

Attribution basis = ALL-CREDITED: a play counts for every credited artist via
unnest(track_metadata.artist_ids). Streak entry rule = ≥1 play of ANY track by the
artist per calendar year (the looser of the workshop's two options — track streaks
already exist, so the artist entry can be more generous).

Detection functions share the two-mode contract of lib/badges.py: pass a list of
artist_ids to scope (cheap, live crons) or None for a full sweep (backfill). Each returns
list[tuple[artist_id, badge_type, context]]. context may carry an 'awarded_at' ISO key,
lifted onto the awarded_at column by award_artist_badge; multi-fire badges carry
context['window'].
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from lib.badges import TZ_AMSTERDAM, _end_of_day_iso, _end_of_month_iso
from lib import notify

# ── Badge catalog ─────────────────────────────────────────────────────────────────
ARTIST_PLAY_THRESHOLDS = [100, 250, 500, 1000, 2500, 5000]
ARTIST_TRACK_THRESHOLDS = [5, 15, 30, 50, 100]
ARTIST_STREAK_THRESHOLDS = [3, 5, 10]

ARTIST_CUMULATIVE_BADGE_TYPES = [f"artist_plays_{n}" for n in ARTIST_PLAY_THRESHOLDS]
ARTIST_DISTINCT_BADGE_TYPES = [f"artist_tracks_{n}" for n in ARTIST_TRACK_THRESHOLDS]
ARTIST_STREAK_BADGE_TYPES = [f"artist_streak_{n}_years" for n in ARTIST_STREAK_THRESHOLDS]
ARTIST_RANKING_BADGE_TYPES = [
    "top_1st_artist_month",
    "top_1st_artist_season",
    "top_1st_artist_year",
    "top_1st_artist_alltime",
    "top_1st_artist_decade",
]
ARTIST_DYNASTY_BADGE_TYPES = ["dynasty"]
ARTIST_REDISCOVERY_BADGE_TYPES = ["rediscovery"]

ARTIST_BADGE_TYPES = (
    ARTIST_CUMULATIVE_BADGE_TYPES
    + ARTIST_DISTINCT_BADGE_TYPES
    + ARTIST_STREAK_BADGE_TYPES
    + ARTIST_RANKING_BADGE_TYPES
    + ARTIST_DYNASTY_BADGE_TYPES
    + ARTIST_REDISCOVERY_BADGE_TYPES
)

# Multi-fire badges carry a non-NULL context['window']; everything else is once-per-artist.
ARTIST_MULTI_FIRE_BADGE_TYPES = set(ARTIST_RANKING_BADGE_TYPES) | {"rediscovery"}

# Category render order — shared with the dashboard artist-lookup grid.
# (display name, [badge_types in slot order], category emoji).
ARTIST_BADGE_CATEGORY_ORDER: list[tuple[str, list[str], str]] = [
    ("Cumulative plays", ARTIST_CUMULATIVE_BADGE_TYPES, "🏆"),
    ("Distinct tracks", ARTIST_DISTINCT_BADGE_TYPES, "📀"),
    ("Streaks", ARTIST_STREAK_BADGE_TYPES, "🔥"),
    ("Rankings", ARTIST_RANKING_BADGE_TYPES, "🎤"),
    ("Dynasty", ARTIST_DYNASTY_BADGE_TYPES, "👑"),
    ("Rediscovery", ARTIST_REDISCOVERY_BADGE_TYPES, "🎭"),
]

ARTIST_BADGE_DISPLAY_LABELS = {
    **{f"artist_plays_{n}": f"{n}+ plays" for n in ARTIST_PLAY_THRESHOLDS},
    **{f"artist_tracks_{n}": f"{n}+ tracks" for n in ARTIST_TRACK_THRESHOLDS},
    **{f"artist_streak_{n}_years": f"{n}-year" for n in ARTIST_STREAK_THRESHOLDS},
    "top_1st_artist_month": "#1 Month",
    "top_1st_artist_season": "#1 Season",
    "top_1st_artist_year": "#1 Year",
    "top_1st_artist_alltime": "#1 All-time",
    "top_1st_artist_decade": "#1 Decade",
    "dynasty": "Dynasty",
    "rediscovery": "Rediscovery",
}

ARTIST_BADGE_HEADLINE = {
    **{f"artist_plays_{n}": f"{n}+ cumulative plays" for n in ARTIST_PLAY_THRESHOLDS},
    **{f"artist_tracks_{n}": f"{n}+ distinct tracks explored" for n in ARTIST_TRACK_THRESHOLDS},
    **{f"artist_streak_{n}_years": f"{n}-year listening streak" for n in ARTIST_STREAK_THRESHOLDS},
    "top_1st_artist_month": "#1 artist of the month",
    "top_1st_artist_season": "#1 artist of the season",
    "top_1st_artist_year": "#1 artist of the year",
    "top_1st_artist_alltime": "#1 artist all-time",
    "top_1st_artist_decade": "#1 artist of the decade",
    "dynasty": "Dynasty (3+ tracks in the all-time Top 100)",
    "rediscovery": "Rediscovery (a dormant favorite revived)",
}

# Category emoji per badge_type (push titles).
ARTIST_BADGE_EMOJI = {
    bt: emoji for _name, badge_types, emoji in ARTIST_BADGE_CATEGORY_ORDER for bt in badge_types
}


# ── Existence / display helpers ───────────────────────────────────────────────────

def _has_artist_badge(conn, artist_id: str, badge_type: str, window: str | None = None) -> bool:
    """True if this (artist, badge_type, window) badge already exists (window matched by
    context->>'window', NULL for once-per-artist lifetime badges)."""
    with conn.cursor() as cur:
        if window is None:
            cur.execute(
                """
                SELECT 1 FROM badge_events
                WHERE entity_type = 'artist' AND entity_id = %s AND badge_type = %s
                  AND context->>'window' IS NULL
                LIMIT 1
                """,
                (artist_id, badge_type),
            )
        else:
            cur.execute(
                """
                SELECT 1 FROM badge_events
                WHERE entity_type = 'artist' AND entity_id = %s AND badge_type = %s
                  AND context->>'window' = %s
                LIMIT 1
                """,
                (artist_id, badge_type, window),
            )
        return cur.fetchone() is not None


def artist_display_name(conn, artist_id: str) -> str:
    """Human display name for an artist_id via track_metadata's parallel artist arrays."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT aname
            FROM track_metadata tm
            CROSS JOIN LATERAL unnest(tm.artist_ids, tm.artist_names) AS u(aid, aname)
            WHERE aid = %s AND aname IS NOT NULL AND aname <> ''
            LIMIT 1
            """,
            (artist_id,),
        )
        row = cur.fetchone()
    return row[0] if row and row[0] else "(unknown artist)"


def _artist_first_play_in_year(conn, artist_id: str, year: int):
    """MIN(played_at) for any track crediting this artist within a local calendar year."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT MIN(sp.played_at)
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE %s = ANY(tm.artist_ids)
              AND EXTRACT(YEAR FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int = %s
            """,
            (artist_id, year),
        )
        row = cur.fetchone()
        return row[0] if row else None


# ── Award / notify ────────────────────────────────────────────────────────────────

def award_artist_badge(
    conn,
    artist_id: str,
    badge_type: str,
    context: dict,
    notify_user: bool = True,
) -> bool:
    """Insert an artist badge_events row (ON CONFLICT DO NOTHING on the windowed unique
    index) and optionally push it (kind 'artist_badge'). Mirrors lib.badges.award_special_badge.

    Returns True if newly inserted; False on a UNIQUE conflict. A push problem never changes
    the result (the badge WAS earned). An
    'awarded_at' ISO string in context is lifted onto the awarded_at column; multi-fire
    badges must include context['window'].
    """
    ctx = dict(context)
    awarded_at_iso = ctx.pop("awarded_at", None)
    awarded_at = datetime.fromisoformat(awarded_at_iso) if awarded_at_iso else None

    with conn.cursor() as cur:
        if awarded_at is None:
            cur.execute(
                """
                INSERT INTO badge_events (entity_type, entity_id, badge_type, context)
                VALUES ('artist', %s, %s, %s::jsonb)
                ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window'))
                    DO NOTHING
                RETURNING id
                """,
                (artist_id, badge_type, json.dumps(ctx)),
            )
        else:
            cur.execute(
                """
                INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
                VALUES ('artist', %s, %s, %s, %s::jsonb)
                ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window'))
                    DO NOTHING
                RETURNING id
                """,
                (artist_id, badge_type, awarded_at, json.dumps(ctx)),
            )
        inserted = cur.fetchone() is not None
    conn.commit()

    if not inserted:
        return False
    if not notify_user:
        return True

    try:
        who = artist_display_name(conn, artist_id)
    except Exception:
        who = artist_id
    window = ctx.get("window")
    notify.notify(conn, "artist_badge", title=f"{ARTIST_BADGE_EMOJI.get(badge_type, '🎤')} {ARTIST_BADGE_HEADLINE.get(badge_type, badge_type)}",
                  body=who + (f" · {window}" if window else ""), url=f"/artist/{artist_id}",
                  dedupe_key=f"badge:artist:{artist_id}:{badge_type}:{window or ''}")
    return True


def award_artist_badge_to_collector(conn, collector, artist_id: str, badge_type: str, context: dict) -> bool:
    """Insert the artist badge (notify_user=False) and, if newly inserted, add it to the
    ingest-run collector for the coalesced digest. Returns True if newly inserted."""
    inserted = award_artist_badge(conn, artist_id, badge_type, context, notify_user=False)
    if inserted:
        collector.add_artist(artist_id, badge_type, context)
    return inserted


# ── Detection: cumulative plays + distinct tracks ─────────────────────────────────

def _artist_aggregate(conn, batch_artist_ids: list[str] | None):
    """{artist_id: (plays, distinct_tracks, first_played)} — all-credited, over full
    history for the given artists (or every artist when batch is None)."""
    where_batch = ""
    params: list = []
    if batch_artist_ids is not None:
        if not batch_artist_ids:
            return {}
        where_batch = "AND aid = ANY(%s)"
        params = [list(batch_artist_ids)]

    sql = f"""
    SELECT aid AS artist_id,
           COUNT(*) AS plays,
           COUNT(DISTINCT sp.track_uri) AS tracks,
           MIN(sp.played_at) AS first_played
    FROM spotify_plays sp
    JOIN track_metadata tm ON tm.track_uri = sp.track_uri
    CROSS JOIN LATERAL unnest(tm.artist_ids) AS aid
    WHERE sp.track_uri IS NOT NULL
      {where_batch}
    GROUP BY aid
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return {r[0]: (r[1], r[2], r[3]) for r in cur.fetchall()}


def _existing_artist_badges(conn, artist_ids: list[str], badge_types: list[str]) -> set[tuple[str, str]]:
    """Set of (artist_id, badge_type) already awarded among these candidates (single-fire
    lookup — NULL window). One query instead of N, for efficient detection/backfill."""
    if not artist_ids:
        return set()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT entity_id, badge_type FROM badge_events
            WHERE entity_type = 'artist'
              AND entity_id = ANY(%s)
              AND badge_type = ANY(%s)
              AND context->>'window' IS NULL
            """,
            (list(artist_ids), list(badge_types)),
        )
        return {(r[0], r[1]) for r in cur.fetchall()}


def detect_artist_play_milestones(conn, batch_artist_ids: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """artist_plays_{100..5000} — cumulative all-credited plays per artist. Single-fire."""
    agg = _artist_aggregate(conn, batch_artist_ids)
    existing = _existing_artist_badges(conn, list(agg.keys()), ARTIST_CUMULATIVE_BADGE_TYPES)
    results: list[tuple[str, str, dict]] = []
    for artist_id, (plays, tracks, first_played) in agg.items():
        for n in ARTIST_PLAY_THRESHOLDS:
            if plays < n:
                continue
            badge_type = f"artist_plays_{n}"
            if (artist_id, badge_type) in existing:
                continue
            ctx = {
                "total_plays": plays,
                "distinct_tracks_played": tracks,
                "basis": "all_credited",
            }
            if first_played is not None:
                ctx["first_played"] = first_played.astimezone(TZ_AMSTERDAM).date().isoformat()
            results.append((artist_id, badge_type, ctx))
    return results


def detect_artist_distinct_tracks_milestones(conn, batch_artist_ids: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """artist_tracks_{5,15,30,50,100} — distinct tracks per artist (all-credited). Single-fire."""
    agg = _artist_aggregate(conn, batch_artist_ids)
    existing = _existing_artist_badges(conn, list(agg.keys()), ARTIST_DISTINCT_BADGE_TYPES)
    results: list[tuple[str, str, dict]] = []
    for artist_id, (plays, tracks, _first) in agg.items():
        for n in ARTIST_TRACK_THRESHOLDS:
            if tracks < n:
                continue
            badge_type = f"artist_tracks_{n}"
            if (artist_id, badge_type) in existing:
                continue
            results.append((artist_id, badge_type, {"distinct_tracks": tracks, "cumulative_plays": plays}))
    return results


# ── Detection: streaks ────────────────────────────────────────────────────────────

def detect_artist_streaks(conn, batch_artist_ids: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """artist_streak_{3,5,10}_years — ≥1 play of ANY track by the artist in each of N
    consecutive calendar years (gaps-and-islands per artist_id, all-credited). Single-fire.
    """
    where_batch = ""
    params: list = []
    if batch_artist_ids is not None:
        if not batch_artist_ids:
            return []
        where_batch = "AND aid = ANY(%s)"
        params = [list(batch_artist_ids)]

    sql = f"""
    WITH years AS (
        SELECT DISTINCT aid AS artist_id,
               EXTRACT(YEAR FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int AS yr
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        CROSS JOIN LATERAL unnest(tm.artist_ids) AS aid
        WHERE sp.track_uri IS NOT NULL
          {where_batch}
    ),
    islands AS (
        SELECT artist_id, yr,
               yr - ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY yr) AS island
        FROM years
    ),
    runs AS (
        SELECT artist_id, MIN(yr) AS run_start, COUNT(*) AS run_len
        FROM islands
        GROUP BY artist_id, island
    ),
    best AS (
        SELECT DISTINCT ON (artist_id) artist_id, run_start, run_len
        FROM runs
        ORDER BY artist_id, run_len DESC, run_start ASC
    )
    SELECT artist_id, run_start, run_len FROM best WHERE run_len >= 3
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    existing = _existing_artist_badges(conn, [r[0] for r in rows], ARTIST_STREAK_BADGE_TYPES)
    results: list[tuple[str, str, dict]] = []
    for artist_id, run_start, run_len in rows:
        for n in ARTIST_STREAK_THRESHOLDS:
            if run_len < n:
                continue
            badge_type = f"artist_streak_{n}_years"
            if (artist_id, badge_type) in existing:
                continue
            cross_year = run_start + n - 1
            ctx = {
                "consecutive_years": run_len,
                "streak_start_year": run_start,
                "streak_end_year": run_start + n - 1,
            }
            nth_year_first = _artist_first_play_in_year(conn, artist_id, cross_year)
            if nth_year_first is not None:
                ctx["awarded_at"] = nth_year_first.isoformat()
            results.append((artist_id, badge_type, ctx))
    return results


# ── Detection: rankings (top artist of a period) ──────────────────────────────────

def compute_top_artist_from_snapshot(conn, ranked: list[dict]) -> tuple[str, int] | None:
    """(artist_id, plays_in_period) for the artist with the most in-period plays across a
    snapshot's ranked tracks (all-credited). None if no artist metadata is available.

    ranked is create_snapshots' rank_period_tracks output: dicts with 'track_uri' and
    'plays_in_period'. Aggregates each track's plays onto every credited artist and returns
    the max — usually the artist of the #1 track, but not always.
    """
    if not ranked:
        return None
    plays_by_uri = {t["track_uri"]: t.get("plays_in_period", 0) for t in ranked}
    uris = list(plays_by_uri.keys())
    with conn.cursor() as cur:
        cur.execute(
            "SELECT track_uri, artist_ids FROM track_metadata WHERE track_uri = ANY(%s)",
            (uris,),
        )
        meta = {r[0]: (r[1] or []) for r in cur.fetchall()}

    totals: dict[str, int] = {}
    for uri, plays in plays_by_uri.items():
        for aid in meta.get(uri, []):
            totals[aid] = totals.get(aid, 0) + plays
    if not totals:
        return None
    top_artist = max(totals.items(), key=lambda kv: kv[1])
    # Cast plays to plain int — plays_in_period can arrive as Decimal, which is not
    # JSON-serializable when stored in the badge context.
    return (top_artist[0], int(top_artist[1]))


# ── Detection: dynasty (≥3 tracks in the all-time Top 100) ─────────────────────────

def detect_dynasty_badges(conn, batch_artist_ids: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """dynasty — an artist with ≥3 distinct tracks in the CURRENT all-time Top 100 (by
    total plays), all-credited. Single-fire live-state achievement (kept even if the artist
    later drops out). Runs at weekly cron end after the Top playlists refresh.
    """
    from lib.playlists import query_top_all_time

    top100 = query_top_all_time(100)(conn)  # list of track_uris
    if not top100:
        return []

    with conn.cursor() as cur:
        cur.execute(
            "SELECT track_uri, artist_ids FROM track_metadata WHERE track_uri = ANY(%s)",
            (list(top100),),
        )
        meta = {r[0]: (r[1] or []) for r in cur.fetchall()}

    # artist_id -> set of its track_uris that sit in the Top 100.
    by_artist: dict[str, set[str]] = {}
    for uri in top100:
        for aid in meta.get(uri, []):
            by_artist.setdefault(aid, set()).add(uri)

    qualifying = {aid: uris for aid, uris in by_artist.items() if len(uris) >= 3}
    if batch_artist_ids is not None:
        batch = set(batch_artist_ids)
        qualifying = {aid: uris for aid, uris in qualifying.items() if aid in batch}

    existing = _existing_artist_badges(conn, list(qualifying.keys()), ARTIST_DYNASTY_BADGE_TYPES)
    results: list[tuple[str, str, dict]] = []
    for artist_id, uris in qualifying.items():
        if (artist_id, "dynasty") in existing:
            continue
        # Track names for the context list.
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT ON (track_uri) track_uri, track_name
                FROM spotify_plays WHERE track_uri = ANY(%s)
                ORDER BY track_uri, played_at DESC
                """,
                (list(uris),),
            )
            names = [r[1] for r in cur.fetchall() if r[1]]
        results.append((artist_id, "dynasty", {
            "tracks_in_alltime_top_100": names,
            "count": len(uris),
            "basis": "all_credited",
        }))
    return results


# ── Detection: rediscovery (dormant favorite revived) ─────────────────────────────

def detect_rediscovery_badges(conn, batch_artist_ids: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """rediscovery — an artist with prior ≥50 total plays who went ≥12 consecutive months
    with zero plays, then returned with ≥20 plays in a single subsequent month. Multi-fire
    on the revival month (context['window'] = 'YYYY-MM').

    Deliberately NOT called 'comeback': the workshop proved established-artist comeback
    doesn't exist in this data (max prior 81 plays), so this looser framing catches genuine
    minor-artist rediscoveries.
    """
    where_batch = ""
    params: list = []
    if batch_artist_ids is not None:
        if not batch_artist_ids:
            return []
        where_batch = "AND aid = ANY(%s)"
        params = [list(batch_artist_ids)]

    sql = f"""
    WITH monthly AS (
        SELECT aid AS artist_id,
               date_trunc('month', sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS mon,
               COUNT(*) AS plays
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        CROSS JOIN LATERAL unnest(tm.artist_ids) AS aid
        WHERE sp.track_uri IS NOT NULL
          {where_batch}
        GROUP BY aid, mon
    ),
    candidates AS (
        SELECT artist_id, mon, plays FROM monthly WHERE plays >= 20
    )
    SELECT c.artist_id, c.mon, c.plays,
           (SELECT MAX(m.mon) FROM monthly m
             WHERE m.artist_id = c.artist_id AND m.mon < c.mon) AS last_active,
           (SELECT COALESCE(SUM(m.plays), 0) FROM monthly m
             WHERE m.artist_id = c.artist_id AND m.mon < c.mon) AS prior_total
    FROM candidates c
    WHERE NOT EXISTS (
        SELECT 1 FROM monthly m
        WHERE m.artist_id = c.artist_id
          AND m.mon >= (c.mon - INTERVAL '12 months')
          AND m.mon <  c.mon
    )
    AND (SELECT COALESCE(SUM(m.plays), 0) FROM monthly m
          WHERE m.artist_id = c.artist_id AND m.mon < c.mon) >= 50
    ORDER BY c.artist_id, c.mon
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    results: list[tuple[str, str, dict]] = []
    for artist_id, mon, plays, last_active, prior_total in rows:
        window = mon.strftime("%Y-%m")
        if _has_artist_badge(conn, artist_id, "rediscovery", window):
            continue
        results.append((artist_id, "rediscovery", {
            "window": window,
            # SUM()/COUNT() come back as Decimal/bigint — cast to plain int so the context
            # is JSON-serializable (json.dumps chokes on Decimal).
            "plays": int(plays),
            "last_active": last_active.strftime("%Y-%m") if last_active else None,
            "prior_total": int(prior_total),
            "awarded_at": _end_of_month_iso(mon),
        }))
    return results


