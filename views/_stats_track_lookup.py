"""Track Lookup tab — search your listening history by track name or artist."""

import pandas as pd
import streamlit as st

from lib.db import get_connection
from lib.artist_popularity import get_scores as get_artist_scores
from lib.track_popularity import get_scores as get_track_scores
from views._skeleton import skeleton_chart, skeleton_metric_row, skeleton_table


_REASON_END_LABELS = {
    "trackdone": "Played to end",
    "fwdbtn": "Skipped forward",
    "endplay": "Started another track",
    "backbtn": "Went back",
    "unexpected-exit-while-paused": "App closed (paused)",
    "unexpected-exit": "App closed (playing)",
    "remote": "Switched device",
    "logout": "Logged out",
    "trackerror": "Track error",
    "unknown": "Unknown",
}


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
def _get_popularity_scores(track_uri: str) -> dict | None:
    return get_track_scores(get_connection(), track_uri)


@st.cache_data(ttl=60)
def _get_artist_popularity_scores(artist_name: str) -> dict | None:
    return get_artist_scores(get_connection(), artist_name)


@st.cache_data(ttl=60)
def _track_skip_rate(track_uri: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            reason_end,
            COUNT(*) AS play_count,
            ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage
        FROM spotify_plays
        WHERE track_uri = %s
          AND reason_end IS NOT NULL
        GROUP BY reason_end
        ORDER BY play_count DESC
        """,
        (track_uri,),
    )


@st.cache_data(ttl=60)
def _track_heard_alongside(track_uri: str, window_minutes: int = 30) -> pd.DataFrame:
    return _run_query(
        """
        WITH target_plays AS (
            SELECT played_at FROM spotify_plays
            WHERE track_uri = %s
        )
        SELECT
            sp.artist_name AS companion_artist,
            sp.track_name AS companion_track,
            sp.track_uri AS companion_uri,
            COUNT(*) AS co_occurrences
        FROM spotify_plays sp, target_plays tp
        WHERE sp.played_at BETWEEN tp.played_at - (INTERVAL '1 minute' * %s)
                               AND tp.played_at + (INTERVAL '1 minute' * %s)
          AND sp.track_uri != %s
          AND sp.track_uri IS NOT NULL
          AND sp.artist_name IS NOT NULL
        GROUP BY sp.track_uri, sp.artist_name, sp.track_name
        ORDER BY co_occurrences DESC
        LIMIT 10
        """,
        (track_uri, window_minutes, window_minutes, track_uri),
    )


@st.cache_data(ttl=60)
def _more_from_artist(track_uri: str) -> pd.DataFrame:
    return _run_query(
        """
        WITH target_artists AS (
            SELECT artist_names FROM track_metadata WHERE track_uri = %s
        )
        SELECT sp.track_name, sp.track_uri, COUNT(*) AS plays
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        CROSS JOIN target_artists ta
        WHERE sp.track_uri != %s
          AND tm.artist_names IS NOT NULL
          AND ta.artist_names IS NOT NULL
          AND tm.artist_names && ta.artist_names
        GROUP BY sp.track_name, sp.track_uri
        ORDER BY plays DESC
        LIMIT 10
        """,
        (track_uri, track_uri),
    )


def render_track_lookup_section() -> None:
    """Render the Track Lookup section content."""
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

    # ── Listening completion ──────────────────────────────────────────────────
    st.subheader("Listening completion")
    ph_skip = st.empty()
    with ph_skip.container():
        skeleton_metric_row(1)
        skeleton_table(5)
    skip_df = _track_skip_rate(track_uri)
    ph_skip.empty()

    if not skip_df.empty:
        trackdone_rows = skip_df[skip_df["reason_end"] == "trackdone"]
        completion_pct = float(trackdone_rows["percentage"].iloc[0]) if not trackdone_rows.empty else 0.0
        st.metric("Completion rate", f"{completion_pct:.1f}%")
        disp_skip = skip_df.copy()
        disp_skip["Reason"] = disp_skip["reason_end"].map(lambda r: _REASON_END_LABELS.get(r, r))
        disp_skip = disp_skip.rename(columns={"play_count": "Plays", "percentage": "%"})
        disp_skip["%"] = disp_skip["%"].map(lambda x: f"{float(x):.1f}%")
        st.dataframe(disp_skip[["Reason", "Plays", "%"]], hide_index=True)
        st.caption(
            "Completion rate is the fraction of plays that ran to the end. "
            "Lower values mean you tend to skip this track."
        )
    else:
        st.info("No reason_end data available for this track.")

    st.divider()

    # ── Heard alongside ───────────────────────────────────────────────────────
    st.subheader("Heard alongside")
    ph_alongside = st.empty()
    with ph_alongside.container():
        skeleton_table(10)
    alongside_df = _track_heard_alongside(track_uri)
    ph_alongside.empty()

    if not alongside_df.empty:
        disp_alongside = alongside_df.rename(columns={
            "companion_artist": "Artist",
            "companion_track": "Track",
            "co_occurrences": "Times together",
        })[["Artist", "Track", "Times together"]]
        st.dataframe(disp_alongside, hide_index=True)
        st.caption(
            "Tracks most frequently played within 30 minutes of this one. "
            "Hints at the session/playlist context this track lives in."
        )
    else:
        st.info("No co-play data found for this track.")

    st.divider()

    # ── More from this artist ─────────────────────────────────────────────────
    st.subheader(f"More from {artist_name}")
    ph_more = st.empty()
    with ph_more.container():
        skeleton_table(10)
    more_df = _more_from_artist(track_uri)
    ph_more.empty()

    if not more_df.empty:
        more_df = more_df.rename(columns={"track_name": "Track", "plays": "Plays"})
        more_df.insert(0, "Rank", range(1, len(more_df) + 1))
        st.dataframe(more_df[["Rank", "Track", "Plays"]], hide_index=True, width="stretch")
    else:
        st.info("No other tracks found for this artist.")

    st.divider()

    # ── Artist popularity ─────────────────────────────────────────────────────
    st.subheader(f"Artist popularity — {artist_name}")
    ph_apop = st.empty()
    with ph_apop.container():
        skeleton_metric_row(6)
    artist_scores = _get_artist_popularity_scores(artist_name)
    ph_apop.empty()

    if artist_scores is None:
        st.caption("Not enough plays for artist scoring (need 100+).")
    else:
        ac1, ac2, ac3, ac4, ac5, ac6 = st.columns(6)
        ac1.metric("Composite",  f"{float(artist_scores['composite_score']):.3f}")
        ac2.metric("Sticky",     f"{float(artist_scores['sticky_pct']) * 100:.0f}%")
        ac3.metric("Evergreen",  f"{float(artist_scores['evergreen_pct']) * 100:.0f}%")
        ac4.metric("Depth",      f"{float(artist_scores['depth_pct']) * 100:.0f}%")
        ac5.metric(
            "Saved",
            f"{float(artist_scores['saved_count_pct']) * 100:.0f}%",
            help=f"{int(artist_scores['saved_count_raw'])} liked tracks",
        )
        ac6.metric("Devotion",   f"{float(artist_scores['devotion_pct']) * 100:.0f}%")
        st.caption(
            "Composite uses plays (30%), sticky and evergreen (20% each), "
            "depth + saved + inverse-devotion (10% each). "
            "Saved = distinct tracks of this artist in your Liked Songs. "
            "Devotion = top track's share of artist plays (inverted in composite so broad catalog love is rewarded). "
            "Population: artists with 100+ total plays."
        )

    st.divider()

    # ── Popularity scores ─────────────────────────────────────────────────────
    st.subheader("Popularity scores")
    ph_pop = st.empty()
    with ph_pop.container():
        skeleton_metric_row(5)
    scores = _get_popularity_scores(track_uri)
    ph_pop.empty()

    if scores is None:
        st.caption("Not enough plays for popularity scoring (need 20+).")
    else:
        pc1, pc2, pc3, pc4, pc5 = st.columns(5)
        pc1.metric("Composite",    f"{float(scores['composite_score']) * 100:.0f}%")
        pc2.metric("Sticky",       f"{float(scores['sticky_pct']) * 100:.0f}th pct")
        pc3.metric("Evergreen",    f"{float(scores['evergreen_pct']) * 100:.0f}th pct")
        pc4.metric("Flash hit",    f"{float(scores['flash_hit_pct']) * 100:.0f}th pct")
        pc5.metric("Session loop", f"{float(scores['session_loop_pct']) * 100:.0f}th pct")
        st.caption(
            "Composite blends raw plays (40%), sticky and evergreen (20% each), "
            "flash hit and session loop (10% each). "
            "All sub-scores are percentile ranks against tracks with 20+ plays."
        )
