"""Phantom plays tab — catalog-delisted tracks with no recoverable metadata."""

import pandas as pd
import streamlit as st

from lib.db import get_connection
from views._skeleton import skeleton_chart, skeleton_metric_row, skeleton_placeholder, skeleton_table

_WHERE = "WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL"


def _run(sql: str) -> pd.DataFrame:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(sql)
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


@st.cache_data(ttl=300)
def _phantom_summary() -> dict:
    df = _run(f"""
        SELECT
            COUNT(*) AS total_count,
            MIN(played_at AT TIME ZONE 'Europe/Amsterdam')::date AS earliest_date,
            MAX(played_at AT TIME ZONE 'Europe/Amsterdam')::date AS latest_date,
            STRING_AGG(DISTINCT COALESCE(platform, '(null)'), ', ' ORDER BY COALESCE(platform, '(null)')) AS platforms_csv
        FROM spotify_plays
        {_WHERE}
    """)
    row = df.iloc[0]
    return {
        "total_count":    int(row["total_count"]),
        "earliest_date":  str(row["earliest_date"]) if row["earliest_date"] else "—",
        "latest_date":    str(row["latest_date"])   if row["latest_date"]   else "—",
        "platforms_csv":  str(row["platforms_csv"]) if row["platforms_csv"] else "—",
    }


@st.cache_data(ttl=300)
def _phantom_by_month() -> pd.DataFrame:
    return _run(f"""
        SELECT DATE_TRUNC('month', played_at AT TIME ZONE 'Europe/Amsterdam') AS month,
               COUNT(*) AS count
        FROM spotify_plays
        {_WHERE}
        GROUP BY month
        ORDER BY month
    """)


@st.cache_data(ttl=300)
def _phantom_by_platform() -> pd.DataFrame:
    return _run(f"""
        SELECT COALESCE(platform, '(null)') AS platform, COUNT(*) AS count
        FROM spotify_plays
        {_WHERE}
        GROUP BY platform
        ORDER BY count DESC
    """)


@st.cache_data(ttl=300)
def _phantom_by_reason_end() -> pd.DataFrame:
    return _run(f"""
        SELECT COALESCE(reason_end, '(null)') AS reason_end, COUNT(*) AS count
        FROM spotify_plays
        {_WHERE}
        GROUP BY reason_end
        ORDER BY count DESC
    """)


@st.cache_data(ttl=300)
def _phantom_recent(limit: int = 30) -> pd.DataFrame:
    return _run(f"""
        SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::timestamp AS played_at,
               COALESCE(platform, '(null)') AS platform,
               COALESCE(reason_end, '(null)') AS reason_end
        FROM spotify_plays
        {_WHERE}
        ORDER BY played_at DESC
        LIMIT {limit}
    """)


def render_phantom_plays_tab() -> None:
    """Render the Phantom plays tab content."""
    st.caption(
        "These are plays where Spotify's recently-played API returned no track metadata — "
        "typically tracks that were in your listening history but later removed from Spotify's "
        "catalog. The plays themselves are real, but the identifying info is permanently lost. "
        "Track them here as a data-quality signal; there's nothing actionable about individual rows."
    )

    # ── Summary metrics ───────────────────────────────────────────────────────
    with skeleton_placeholder("metric_row") as ph_sum:
        summary = _phantom_summary()
    ph_sum.empty()

    mc1, mc2, mc3 = st.columns(3)
    mc1.metric("Total phantom plays", f"{summary['total_count']:,}")
    mc2.metric("Earliest",            summary["earliest_date"])
    mc3.metric("Latest",              summary["latest_date"])

    st.divider()

    # ── Plays over time ───────────────────────────────────────────────────────
    st.subheader("Phantom plays over time")
    with skeleton_placeholder("chart") as ph_chart:
        monthly_df = _phantom_by_month()
    ph_chart.empty()

    if not monthly_df.empty:
        monthly_df["month"] = pd.to_datetime(monthly_df["month"])
        st.line_chart(monthly_df.set_index("month")["count"])
    st.caption("If this is rising, more tracks are being delisted from Spotify recently.")

    st.divider()

    # ── Platform + reason_end breakdown ──────────────────────────────────────
    st.subheader("Breakdown")
    bc1, bc2 = st.columns(2)

    with bc1:
        st.markdown("**By platform**")
        with skeleton_placeholder("table") as ph_plat:
            plat_df = _phantom_by_platform()
        ph_plat.empty()
        st.dataframe(plat_df, hide_index=True, width="stretch")

    with bc2:
        st.markdown("**By reason end**")
        with skeleton_placeholder("table") as ph_reason:
            reason_df = _phantom_by_reason_end()
        ph_reason.empty()
        st.dataframe(reason_df, hide_index=True, width="stretch")

    st.divider()

    # ── Recent phantom plays ──────────────────────────────────────────────────
    st.subheader("Recent phantom plays (last 30)")
    with skeleton_placeholder("table") as ph_recent:
        recent_df = _phantom_recent(30)
    ph_recent.empty()

    if not recent_df.empty:
        recent_df["played_at"] = pd.to_datetime(recent_df["played_at"]).dt.strftime("%Y-%m-%d %H:%M")
        st.dataframe(recent_df, hide_index=True, width="stretch")
    else:
        st.info("No phantom plays found.")
