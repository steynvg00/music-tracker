"""Track Lookup tab — search your listening history by track name or artist."""

import pandas as pd
import streamlit as st

from lib.db import get_connection
from views._skeleton import skeleton_chart, skeleton_metric_row, skeleton_table


def _run_query(sql: str, params: tuple) -> pd.DataFrame:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(sql, params)
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


@st.cache_data(ttl=60)
def _search_tracks(query: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT DISTINCT artist_name, track_name, track_uri, COUNT(*) AS plays
        FROM spotify_plays
        WHERE artist_name ILIKE %s OR track_name ILIKE %s
        GROUP BY artist_name, track_name, track_uri
        ORDER BY plays DESC
        LIMIT 20
        """,
        (f"%{query}%", f"%{query}%"),
    )


@st.cache_data(ttl=60)
def _track_detail(track_uri: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            sp.track_name,
            sp.artist_name,
            sp.album_name,
            tm.release_date,
            tm.duration_ms,
            EXISTS (
                SELECT 1 FROM liked_songs ls WHERE ls.track_uri = sp.track_uri
            ) AS is_liked
        FROM spotify_plays sp
        LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        WHERE sp.track_uri = %s
        LIMIT 1
        """,
        (track_uri,),
    )


@st.cache_data(ttl=60)
def _track_metrics(track_uri: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            COUNT(*) AS total_plays,
            MIN(played_at) AS first_played,
            MAX(played_at) AS last_played,
            COUNT(DISTINCT DATE(played_at)) AS days_listened
        FROM spotify_plays
        WHERE track_uri = %s
        """,
        (track_uri,),
    )


@st.cache_data(ttl=60)
def _plays_per_month(track_uri: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT date_trunc('month', played_at) AS month, COUNT(*) AS plays
        FROM spotify_plays
        WHERE track_uri = %s
        GROUP BY month
        ORDER BY month
        """,
        (track_uri,),
    )


@st.cache_data(ttl=60)
def _more_from_artist(artist_name: str, track_uri: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT track_name, COUNT(*) AS plays
        FROM spotify_plays
        WHERE artist_name = %s AND track_uri != %s
        GROUP BY track_name
        ORDER BY plays DESC
        LIMIT 10
        """,
        (artist_name, track_uri),
    )


def render_track_lookup_tab() -> None:
    """Render the Track Lookup tab content."""
    query = st.text_input("Search by track name or artist", key="track_lookup_query")

    if not query:
        st.caption("Start typing to search your listening history")
        return

    ph_search = st.empty()
    with ph_search.container():
        skeleton_table(20)
    results_df = _search_tracks(query)
    ph_search.empty()

    if results_df.empty:
        st.info("No tracks found matching your search.")
        return

    def _fmt(idx: int) -> str:
        row = results_df.iloc[idx]
        return f"{row['artist_name']} — {row['track_name']} ({int(row['plays'])} plays)"

    selected_idx = st.selectbox(
        "Select a track",
        range(len(results_df)),
        format_func=_fmt,
        key="track_lookup_select",
    )

    selected = results_df.iloc[selected_idx]
    track_uri = selected["track_uri"]
    artist_name = selected["artist_name"]

    st.divider()

    # ── Track detail header ───────────────────────────────────────────────────
    ph_header = st.empty()
    with ph_header.container():
        skeleton_table(3)
    detail_df = _track_detail(track_uri)
    ph_header.empty()

    if not detail_df.empty:
        d = detail_df.iloc[0]
        liked_badge = "  ❤️ Liked" if d["is_liked"] else ""
        st.header(f"{d['track_name']}{liked_badge}")
        st.subheader(d["artist_name"])
        meta_parts = []
        if d["album_name"]:
            meta_parts.append(f"**Album:** {d['album_name']}")
        if d["release_date"]:
            meta_parts.append(f"**Released:** {d['release_date']}")
        if d["duration_ms"]:
            total_s = int(d["duration_ms"]) // 1000
            meta_parts.append(f"**Duration:** {total_s // 60}:{total_s % 60:02d}")
        if meta_parts:
            st.caption("  ·  ".join(meta_parts))

    # ── Metrics row ───────────────────────────────────────────────────────────
    ph_metrics = st.empty()
    with ph_metrics.container():
        skeleton_metric_row(4)
    metrics_df = _track_metrics(track_uri)
    ph_metrics.empty()

    if not metrics_df.empty:
        m = metrics_df.iloc[0]
        mc1, mc2, mc3, mc4 = st.columns(4)
        mc1.metric("Total plays", f"{int(m['total_plays']):,}")
        mc2.metric(
            "First played",
            pd.to_datetime(m["first_played"]).strftime("%Y-%m-%d") if m["first_played"] is not None else "—",
        )
        mc3.metric(
            "Last played",
            pd.to_datetime(m["last_played"]).strftime("%Y-%m-%d") if m["last_played"] is not None else "—",
        )
        mc4.metric("Days listened", f"{int(m['days_listened']):,}")

    st.divider()

    # ── Plays per month chart ─────────────────────────────────────────────────
    st.subheader("Plays per month")
    ph_chart = st.empty()
    with ph_chart.container():
        skeleton_chart()
    ppm_df = _plays_per_month(track_uri)
    ph_chart.empty()

    if not ppm_df.empty:
        ppm_df["month"] = pd.to_datetime(ppm_df["month"])
        st.line_chart(ppm_df.set_index("month")["plays"])
    else:
        st.info("No monthly play data available.")

    st.divider()

    # ── More from this artist ─────────────────────────────────────────────────
    st.subheader(f"More from {artist_name}")
    ph_more = st.empty()
    with ph_more.container():
        skeleton_table(10)
    more_df = _more_from_artist(artist_name, track_uri)
    ph_more.empty()

    if not more_df.empty:
        more_df = more_df.rename(columns={"track_name": "Track", "plays": "Plays"})
        more_df.insert(0, "Rank", range(1, len(more_df) + 1))
        st.dataframe(more_df[["Rank", "Track", "Plays"]], hide_index=True, width="stretch")
    else:
        st.info("No other tracks found for this artist.")
