"""Track-lookup badge display (v0.70) — the Pokémon-doos in Streamlit.

Renders a canonical track's earned vs. available badges as a 6-category chip grid,
reusing v0.68's `_badge_png_bytes()` (base64-embedded into inline <img> tags via
Streamlit's `st.markdown(unsafe_allow_html=True)`). Badges are aggregated across every
URI variant under the canonical (v0.63.1's "deferred to v0.70" NOTE resolved here).
"""

from __future__ import annotations

import base64
import json
from collections import defaultdict

import streamlit as st

from lib.badges import _badge_png_bytes
from lib.db import get_connection

# Category render order: (display name, badge_types in slot order, category emoji).
# Mirrors the mail Special/Rankings strips and docs/badge_definitions.md categories.
BADGE_CATEGORY_ORDER = [
    ("Play milestones", ["plays_50", "plays_100", "plays_200", "plays_300", "plays_400", "plays_500"], "🏆"),
    ("Rankings", ["top_1st_month", "top_1st_season", "top_1st_year", "top_1st_alltime", "top_1st_decade"], "🥇"),
    ("Streaks", ["streak_5_years", "streak_10_years"], "🔥"),
    ("Daily intensity", ["plays_20_in_day", "plays_40_in_day"], "⚡"),
    ("Release timing", ["played_on_day_one", "day_one_fan", "release_week_fan", "late_bloomer"], "🎬"),
    ("Behavioral", ["comeback", "season_regular", "multi_top"], "🎭"),
]

BADGE_DISPLAY_LABELS = {
    "plays_50": "50+", "plays_100": "100+", "plays_200": "200+",
    "plays_300": "300+", "plays_400": "400+", "plays_500": "500+",
    "top_1st_month": "#1 Month", "top_1st_season": "#1 Season",
    "top_1st_year": "#1 Year", "top_1st_alltime": "#1 All-time", "top_1st_decade": "#1 Decade",
    "streak_5_years": "5-year", "streak_10_years": "10-year",
    "plays_20_in_day": "20/day", "plays_40_in_day": "40/day",
    "played_on_day_one": "Day one", "day_one_fan": "Day-one fan",
    "release_week_fan": "Release week", "late_bloomer": "Late bloomer",
    "comeback": "Comeback", "season_regular": "Season regular", "multi_top": "Multi-top",
}

# Once-per-track-lifetime badges (NULL context window). Canonical aggregation collapses
# every URI variant into one track, so a single-fire badge earned under several variants
# is still ONE achievement — its chip shows no ×N and no window line.
SINGLE_FIRE_BADGE_TYPES = {
    "plays_50", "plays_100", "plays_200", "plays_300", "plays_400", "plays_500",
    "streak_5_years", "streak_10_years",
    "played_on_day_one", "day_one_fan", "release_week_fan", "late_bloomer",
    "season_regular", "multi_top",
}

# Multi-fire badges (per-window rows) — the ×N count and window values are meaningful and
# kept. Derived as the complement so the two sets can never drift out of sync.
MULTI_FIRE_BADGE_TYPES = {
    bt for _name, badge_types, _emoji in BADGE_CATEGORY_ORDER
    for bt in badge_types
    if bt not in SINGLE_FIRE_BADGE_TYPES
}


@st.cache_data(ttl=60)
def _fetch_track_badges(canonical_track_uri: str) -> list[dict]:
    """Every badge_event across all URI variants under this canonical, badge_type-ordered.

    Cached (ttl matched to the other Track-lookup queries) and connection-managed via the
    shared pool — so it takes only the hashable canonical URI, not a connection object.
    Returns a list of plain dicts (badge_type, entity_id, awarded_at, context) so the
    result is picklable for st.cache_data.
    """
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT be.badge_type, be.entity_id, be.awarded_at, be.context
            FROM badge_events be
            WHERE be.entity_type = 'track'
              AND be.entity_id IN (
                  SELECT track_uri FROM track_metadata
                  WHERE canonical_track_uri = %s
              )
            ORDER BY be.badge_type, be.awarded_at ASC
            """,
            (canonical_track_uri,),
        )
        return [
            {"badge_type": bt, "entity_id": eid, "awarded_at": aw, "context": ctx or {}}
            for bt, eid, aw, ctx in cur.fetchall()
        ]


def _months_between(earlier: str, later: str) -> int | None:
    """Whole months from an earlier 'YYYY-MM' to a later one, or None on parse failure."""
    try:
        ey, em = (int(x) for x in earlier.split("-")[:2])
        ly, lm = (int(x) for x in later.split("-")[:2])
    except (ValueError, AttributeError):
        return None
    return (ly - ey) * 12 + (lm - em)


def _format_badge_context(badge_type: str, context: dict) -> str:
    """Human-readable one-line description of a single earned badge's context.

    Complements the awarded_at date shown separately in the details expander. Fields differ
    per badge family (v0.63/v0.65/v0.67) — see docs/badge_definitions.md. Unrecognised
    types fall back to the raw JSON so nothing is silently dropped.
    """
    c = context or {}

    # ── Play milestones — context carries no play-date; the crossing date is the row's
    # awarded_at (rendered alongside), so describe the threshold itself. The suffix must be
    # ALL digits (plays_50…plays_500), which excludes plays_20_in_day / plays_40_in_day.
    if badge_type.startswith("plays_") and badge_type[len("plays_"):].isdigit():
        n = badge_type[len("plays_"):]
        return f"Reached {n} cumulative plays"

    # ── Rankings — #1 of a period.  "June 2026 · 34 plays · 5 ahead of #2"
    if badge_type.startswith("top_1st_"):
        window = c.get("window", "this period")
        parts = [str(window)]
        if c.get("plays_in_window") is not None:
            parts.append(f"{c['plays_in_window']} plays")
        if c.get("rank_2_gap") is not None:
            parts.append(f"{c['rank_2_gap']} ahead of #2")
        return " · ".join(parts)

    # ── Streaks — N consecutive calendar years from the run start.
    if badge_type in ("streak_5_years", "streak_10_years"):
        n = 5 if badge_type == "streak_5_years" else 10
        start = c.get("streak_start_year")
        if start is not None:
            return f"{n} consecutive years from {start} to {int(start) + n - 1}"
        longest = c.get("longest_streak_years", n)
        return f"{n} consecutive years (longest run {longest})"

    # ── Daily intensity — "20 plays on 2026-06-04"
    if badge_type in ("plays_20_in_day", "plays_40_in_day"):
        plays = c.get("plays_that_day", "?")
        day = c.get("window", "?")
        return f"{plays} plays on {day}"

    # ── Release timing
    if badge_type == "played_on_day_one":
        return f"Heard it on release day ({c.get('release_date', '?')})"
    if badge_type == "day_one_fan":
        return f"{c.get('plays_on_release_day', '?')} plays on release day ({c.get('release_date', '?')})"
    if badge_type == "release_week_fan":
        return f"{c.get('plays_in_release_week', '?')} plays in release week (from {c.get('release_date', '?')})"
    if badge_type == "late_bloomer":
        gap_days = c.get("gap_days")
        gap_str = f"{gap_days / 365.25:.1f} years after release" if gap_days is not None else "long after release"
        first = c.get("first_played", "?")
        plays = c.get("plays_within_90d_of_first_play", "?")
        return f"First played {first} ({gap_str}) · {plays} plays in first 90 days"

    # ── Behavioral
    if badge_type == "comeback":
        plays = c.get("plays_that_month", "?")
        window = c.get("window", "?")
        dormant_since = c.get("dormant_since")
        if dormant_since:
            gap = _months_between(dormant_since, window)
            # dormant_since is the last active month; the silent stretch is the gap minus
            # that final active month itself.
            silent = (gap - 1) if gap is not None else None
            if silent is not None and silent > 0:
                return f"{plays} plays in {window} after {silent}-month dormancy"
        return f"{plays} plays in {window} (comeback)"
    if badge_type == "season_regular":
        count = c.get("count", "?")
        seasons = c.get("seasons_qualified") or []
        seasons_str = f": {', '.join(seasons)}" if seasons else ""
        return f"Top 25 in {count} seasons{seasons_str}"
    if badge_type == "multi_top":
        return f"In {c.get('count', '?')} Top playlists simultaneously"

    # Fallback — never silently drop context.
    return json.dumps(c)


def _render_chip(badge_type: str, earned_count: int, earned_windows: list[str] | None = None) -> str:
    """HTML for a single badge chip.

    earned_count == 0  → not earned (desaturated PNG + grey label).
    earned_count >= 1  → earned (full-colour PNG + green label).
    ×N + window line   → ONLY for multi-fire badges (top_1st_*, plays_N_in_day, comeback).
                         Single-fire badges represent one lifetime achievement, so even when
                         canonical aggregation collapses several URI variants that each
                         earned the badge, the chip shows a plain earned state — no ×N, no
                         windows.
    """
    label = BADGE_DISPLAY_LABELS[badge_type]
    is_multi_fire = badge_type in MULTI_FIRE_BADGE_TYPES
    png_bytes = _badge_png_bytes(badge_type, size=64, desaturated=(earned_count == 0))

    if png_bytes is None:
        # Fallback for a missing PNG file (graceful degrade, mirrors v0.68 mail behaviour).
        img_html = "🎖️" if earned_count > 0 else "▫️"
    else:
        b64 = base64.b64encode(png_bytes).decode("ascii")
        img_html = (
            f'<img src="data:image/png;base64,{b64}" width="64" height="64" '
            'style="display:block;margin:0 auto;">'
        )

    color = "#4a5" if earned_count > 0 else "#666"
    # ×N only makes sense for per-window multi-fire badges. Single-fire stays plain.
    count_suffix = f" ×{earned_count}" if (is_multi_fire and earned_count > 1) else ""

    # Single-fire badges never show a window line, regardless of what the caller passed.
    windows_html = ""
    if not is_multi_fire:
        earned_windows = None
    if earned_windows and len(earned_windows) <= 3:
        windows_html = (
            f'<div style="font-size:10px;color:{color};opacity:0.8;">{", ".join(earned_windows)}</div>'
        )
    elif earned_windows and len(earned_windows) > 3:
        windows_html = (
            f'<div style="font-size:10px;color:{color};opacity:0.8;">'
            f'{", ".join(earned_windows[:2])} +{len(earned_windows) - 2}</div>'
        )

    return f"""
    <div style="text-align:center;padding:8px;">
        {img_html}
        <div style="font-size:12px;color:{color};font-weight:bold;margin-top:4px;">{label}{count_suffix}</div>
        {windows_html}
    </div>
    """


def render_badge_chips(conn, canonical_track_uri: str) -> None:
    """Render the Pokémon-doos badge grid for a canonical track in Streamlit.

    Aggregates every badge_event across all URI variants under this canonical, then draws
    6 category rows (earned in colour + label, not-earned desaturated) followed by a
    collapsible "Badge details" section. A track with zero earned badges renders only a
    compact "No badges yet 🎯" line — no empty grid.

    `conn` is accepted for API symmetry with the other detail renderers; the underlying
    query is cached in _fetch_track_badges, which manages its own pooled connection.
    """
    rows = _fetch_track_badges(canonical_track_uri)

    badges_by_type: dict[str, list] = defaultdict(list)
    for r in rows:
        badges_by_type[r["badge_type"]].append((r["entity_id"], r["awarded_at"], r["context"]))

    # Empty state — no clutter for tracks with no achievements.
    if not badges_by_type:
        st.caption("No badges yet 🎯")
        return

    st.subheader("Badges")

    for category_name, badge_types, emoji in BADGE_CATEGORY_ORDER:
        st.markdown(
            f'<h4 style="font-size:14px;color:#888;font-weight:600;margin:12px 0 2px 0;">'
            f'{emoji} {category_name}</h4>',
            unsafe_allow_html=True,
        )
        ncols = max(3, min(6, len(badge_types)))
        cols = st.columns(ncols)
        for i, badge_type in enumerate(badge_types):
            awards = badges_by_type.get(badge_type, [])
            earned_count = len(awards)
            earned_windows = [ctx.get("window") for _e, _a, ctx in awards if ctx.get("window")]
            chip_html = _render_chip(badge_type, earned_count, earned_windows or None)
            with cols[i % ncols]:
                st.markdown(chip_html, unsafe_allow_html=True)

    # ── Details expander ──────────────────────────────────────────────────────
    with st.expander("📋 Badge details", expanded=False):
        for category_name, badge_types, emoji in BADGE_CATEGORY_ORDER:
            earned_in_category = [(bt, badges_by_type[bt]) for bt in badge_types if bt in badges_by_type]
            if not earned_in_category:
                continue
            st.markdown(f"**{emoji} {category_name}**")
            for badge_type, awards in earned_in_category:
                for _entity_id, awarded_at, context in awards:
                    label = BADGE_DISPLAY_LABELS[badge_type]
                    date_str = awarded_at.strftime("%Y-%m-%d")
                    context_str = _format_badge_context(badge_type, context)
                    st.markdown(f"- **{label}** — {date_str}  \n  {context_str}")
