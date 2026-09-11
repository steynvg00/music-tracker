"""Artist-lookup section (v0.74) — search an artist and see their badge grid.

Mirrors the Track/Album lookup sections. Resolves a name query to a Spotify artist_id via
track_metadata's parallel artist arrays, shows a few headline metrics, then renders the
artist badge grid through the shared _badge_display component (entity_type='artist').
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from lib.db import get_connection
from views._badge_display import render_badge_chips


@st.cache_data(ttl=60)
def _search_artists(query: str) -> list[tuple[str, str, int]]:
    """(artist_id, name, plays) for artists whose credited name matches, most-played first."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT aid, aname, COUNT(*) AS plays
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            CROSS JOIN LATERAL unnest(tm.artist_ids, tm.artist_names) AS u(aid, aname)
            WHERE aname ILIKE %s AND sp.track_uri IS NOT NULL
            GROUP BY aid, aname
            ORDER BY plays DESC
            LIMIT 25
            """,
            (f"%{query.strip()}%",),
        )
        return [(aid, aname, plays) for aid, aname, plays in cur.fetchall()]


@st.cache_data(ttl=60)
def _artist_metrics(artist_id: str) -> dict:
    """Headline metrics for one artist (all-credited)."""
    conn = get_connection()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*) AS plays,
                   COUNT(DISTINCT sp.track_uri) AS tracks,
                   MIN(sp.played_at) AS first_played,
                   MAX(sp.played_at) AS last_played
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE %s = ANY(tm.artist_ids) AND sp.track_uri IS NOT NULL
            """,
            (artist_id,),
        )
        row = cur.fetchone()
    return {
        "plays": row[0] if row else 0,
        "tracks": row[1] if row else 0,
        "first_played": row[2] if row else None,
        "last_played": row[3] if row else None,
    }


def render_artist_lookup_section() -> None:
    """Search box → artist picker → metrics + badge grid."""
    query = st.text_input("Artist name", key="artist_lookup_q", placeholder="e.g. D-Sturb")
    if not query or len(query.strip()) < 2:
        st.caption("Type at least 2 characters to search.")
        return

    matches = _search_artists(query)
    if not matches:
        st.caption("No artists found.")
        return

    options = {f"{name}  ·  {plays:,} plays": aid for aid, name, plays in matches}
    choice = st.selectbox("Matches", list(options.keys()), key="artist_lookup_choice")
    artist_id = options[choice]
    artist_name = choice.split("  ·  ")[0]

    st.header(artist_name)

    m = _artist_metrics(artist_id)
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total plays", f"{m['plays']:,}")
    c2.metric("Distinct tracks", f"{m['tracks']:,}")
    c3.metric(
        "First played",
        pd.to_datetime(m["first_played"]).strftime("%Y-%m-%d") if m["first_played"] is not None else "—",
    )
    c4.metric(
        "Last played",
        pd.to_datetime(m["last_played"]).strftime("%Y-%m-%d") if m["last_played"] is not None else "—",
    )

    # Badge grid (v0.74) — non-fatal, matching the track-lookup guard.
    try:
        render_badge_chips(get_connection(), artist_id, entity_type="artist")
    except Exception as e:
        st.warning(f"Badge display failed: {e}")
