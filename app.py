"""music-tracker dashboard — local Streamlit app for scrobble stats."""

import os
import sys
sys.path.insert(0, ".")

import altair as alt
import pandas as pd
import streamlit as st
from datetime import datetime

# Bridge Streamlit Cloud secrets into os.environ so lib.* modules
# (which read from os.environ) work without modification across local,
# GitHub Actions, and Streamlit Cloud.
try:
    for key in ("DATABASE_URL",):
        if key in st.secrets:
            os.environ[key] = st.secrets[key]
except (FileNotFoundError, AttributeError):
    # st.secrets raises FileNotFoundError locally if no secrets.toml exists.
    # That's fine — .env via dotenv (loaded by lib.db) handles local.
    pass

from lib.db import get_connection

st.set_page_config(page_title="music-tracker", page_icon="🎵", layout="wide")


@st.cache_data(ttl=60)
def query_df(sql: str) -> pd.DataFrame:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(sql)
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


@st.cache_data(ttl=60)
def query_df_params(sql: str, params: tuple) -> pd.DataFrame:
    """Like query_df but accepts query parameters. Cache key includes params tuple."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(sql, params)
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


# ── Header ────────────────────────────────────────────────────────────────────

st.title("🎵 music-tracker")
st.caption("Personal scrobble stats, threshold playlists, and listening patterns.")

today = datetime.now().date()

# ── Sidebar ───────────────────────────────────────────────────────────────────

with st.sidebar:
    if st.button("Refresh data"):
        st.cache_data.clear()
        st.rerun()

# ── Tabs ──────────────────────────────────────────────────────────────────────

tab_overview, tab_top, tab_trends, tab_onthisday = st.tabs([
    "Overview", "Top tracks/artists", "Trends", "On this day"
])

# ── Tab 1: Overview ───────────────────────────────────────────────────────────

with tab_overview:
    col1, col2, col3, col4 = st.columns(4)

    total_scrobbles = query_df(
        "SELECT COUNT(*) AS n FROM scrobbles WHERE source = 'lastfm'"
    ).iloc[0]["n"]
    unique_tracks = query_df(
        "SELECT COUNT(DISTINCT track_id) AS n FROM scrobbles WHERE source = 'lastfm'"
    ).iloc[0]["n"]
    unique_artists = query_df(
        "SELECT COUNT(DISTINCT t.artist_id) AS n FROM scrobbles s JOIN tracks t ON t.id = s.track_id WHERE source = 'lastfm'"
    ).iloc[0]["n"]
    date_range_df = query_df(
        "SELECT MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first, MAX(played_at AT TIME ZONE 'Europe/Amsterdam') AS last FROM scrobbles WHERE source = 'lastfm'"
    )
    first_date = date_range_df.iloc[0]["first"]
    last_date = date_range_df.iloc[0]["last"]
    date_range_str = (
        f"{first_date:%Y-%m-%d} → {last_date:%Y-%m-%d}"
        if first_date and last_date
        else "—"
    )

    col1.metric("Total scrobbles", f"{total_scrobbles:,}")
    col2.metric("Unique tracks", f"{unique_tracks:,}")
    col3.metric("Unique artists", f"{unique_artists:,}")
    col4.metric("Date range", date_range_str)

    # Metrics row 2
    col5, col6, col7, col8 = st.columns(4)

    days_listening = query_df(
        "SELECT COUNT(DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam')) AS n FROM scrobbles WHERE source = 'lastfm'"
    ).iloc[0]["n"]

    current_streak_df = query_df("""
        WITH days AS (
            SELECT DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS d
            FROM scrobbles WHERE source = 'lastfm'
        ),
        groups AS (
            SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM days
        ),
        streaks AS (
            SELECT grp, MIN(d) AS start_d, MAX(d) AS end_d, COUNT(*) AS len FROM groups GROUP BY grp
        )
        SELECT len FROM streaks
        WHERE end_d >= (CURRENT_DATE AT TIME ZONE 'Europe/Amsterdam')::date - INTERVAL '1 day'
        ORDER BY end_d DESC LIMIT 1
    """)
    current_streak = int(current_streak_df.iloc[0]["len"]) if not current_streak_df.empty else 0

    longest_streak_df = query_df("""
        WITH days AS (
            SELECT DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS d
            FROM scrobbles WHERE source = 'lastfm'
        ),
        groups AS (
            SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM days
        ),
        streaks AS (
            SELECT grp, MIN(d) AS start_d, MAX(d) AS end_d, COUNT(*) AS len FROM groups GROUP BY grp
        )
        SELECT MAX(len) AS len FROM streaks
    """)
    longest_streak = int(longest_streak_df.iloc[0]["len"] or 0)

    avg_per_day = int(total_scrobbles / days_listening) if days_listening > 0 else 0

    col5.metric("Days listening", f"{days_listening:,}")
    col6.metric("Current streak", f"{current_streak:,} days")
    col7.metric("Longest streak", f"{longest_streak:,} days")
    col8.metric("Avg scrobbles/day", f"{avg_per_day:,}")

    st.divider()
    st.subheader("Monthly scrobbles")

    monthly_df = query_df("""
        SELECT TO_CHAR(played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS month,
               COUNT(*) AS plays
        FROM scrobbles WHERE source = 'lastfm'
        GROUP BY month ORDER BY month
    """)
    st.bar_chart(monthly_df.set_index("month"))

# ── Tab 2: Top tracks/artists ─────────────────────────────────────────────────

with tab_top:
    period = st.radio(
        "Time period",
        ["All time", "This year", "Last 30 days", "Last 7 days"],
        horizontal=True,
        key="period_filter",
    )

    period_filter = {
        "All time": "",
        "This year": "AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'Europe/Amsterdam'))",
        "Last 30 days": "AND played_at >= NOW() - INTERVAL '30 days'",
        "Last 7 days": "AND played_at >= NOW() - INTERVAL '7 days'",
    }[period]

    top_tracks_sql = f"""
        SELECT a.name AS artist, t.title AS track, COUNT(s.id) AS plays
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE s.source = 'lastfm' {period_filter}
        GROUP BY a.name, t.title
        ORDER BY plays DESC
        LIMIT 50
    """
    st.subheader("Top 50 tracks")
    st.dataframe(query_df(top_tracks_sql), hide_index=True, width='stretch')

    st.divider()

    top_artists_sql = f"""
        SELECT a.name AS artist, COUNT(s.id) AS plays
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE s.source = 'lastfm' {period_filter}
        GROUP BY a.name
        ORDER BY plays DESC
        LIMIT 50
    """
    st.subheader("Top 50 artists")
    st.dataframe(query_df(top_artists_sql), hide_index=True, width='stretch')

# ── Tab 3: Trends ─────────────────────────────────────────────────────────────

with tab_trends:
    years_df = query_df(
        "SELECT DISTINCT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS y FROM scrobbles WHERE source = 'lastfm' ORDER BY y DESC"
    )
    years = years_df["y"].tolist()
    selected_year = st.selectbox("Year", years, index=0)

    st.subheader("Daily scrobbles")

    cal_df = query_df_params(
        """
        SELECT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS day, COUNT(*) AS plays
        FROM scrobbles
        WHERE source = 'lastfm'
          AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
        GROUP BY day
        """,
        (selected_year,),
    )

    year_start = datetime(selected_year, 1, 1).date()
    year_end = datetime(selected_year, 12, 31).date() if selected_year < today.year else today

    all_days = pd.date_range(year_start, year_end, freq="D")
    full_df = pd.DataFrame({"day": all_days})
    full_df["day"] = full_df["day"].dt.date
    cal_df["day"] = pd.to_datetime(cal_df["day"]).dt.date
    full_df = full_df.merge(cal_df, on="day", how="left").fillna(0)
    full_df["plays"] = full_df["plays"].astype(int)
    full_df["day"] = pd.to_datetime(full_df["day"])
    full_df["week"] = full_df["day"].dt.isocalendar().week.astype(int)
    full_df["day_of_week"] = full_df["day"].dt.dayofweek.astype(int)  # 0=Mon

    chart = alt.Chart(full_df).mark_rect().encode(
        x=alt.X("week:O", title="Week"),
        y=alt.Y("day_of_week:O", title="Day", sort=[0, 1, 2, 3, 4, 5, 6],
                axis=alt.Axis(labelExpr="['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][datum.value]")),
        color=alt.Color("plays:Q", title="Scrobbles", scale=alt.Scale(scheme="greens")),
        tooltip=["day:T", "plays:Q"],
    ).properties(height=200)
    st.altair_chart(chart, use_container_width=True)

    st.subheader("When you listen")

    hour_dow_df = query_df("""
        SELECT EXTRACT(DOW FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS dow,
               EXTRACT(HOUR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS hour,
               COUNT(*) AS plays
        FROM scrobbles WHERE source = 'lastfm'
        GROUP BY dow, hour
        ORDER BY dow, hour
    """)
    hour_dow_df["dow"] = (hour_dow_df["dow"] - 1) % 7  # Sun=0..Sat=6 → Mon=0..Sun=6

    hour_chart = alt.Chart(hour_dow_df).mark_rect().encode(
        x=alt.X("hour:O", title="Hour"),
        y=alt.Y("dow:O", title="Day",
                axis=alt.Axis(labelExpr="['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][datum.value]")),
        color=alt.Color("plays:Q", title="Scrobbles", scale=alt.Scale(scheme="blues")),
        tooltip=["dow:O", "hour:O", "plays:Q"],
    ).properties(height=220)
    st.altair_chart(hour_chart, use_container_width=True)

# ── Tab 4: On this day ────────────────────────────────────────────────────────

with tab_onthisday:
    st.subheader("Listened on this date in past years")
    st.caption(f"What you played on this day ({today.strftime('%B %-d')}, in any year).")

    onthisday_df = query_df("""
        SELECT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year,
               a.name AS artist, t.title AS track, COUNT(*) AS plays
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE s.source = 'lastfm'
          AND EXTRACT(MONTH FROM played_at AT TIME ZONE 'Europe/Amsterdam') = EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'Europe/Amsterdam'))
          AND EXTRACT(DAY FROM played_at AT TIME ZONE 'Europe/Amsterdam') = EXTRACT(DAY FROM (NOW() AT TIME ZONE 'Europe/Amsterdam'))
        GROUP BY year, artist, track
        ORDER BY year DESC, plays DESC
    """)

    if onthisday_df.empty:
        st.info("No scrobbles on this date in any prior year.")
    else:
        for year in sorted(onthisday_df["year"].unique(), reverse=True):
            year_df = onthisday_df[onthisday_df["year"] == year]
            with st.expander(
                f"{year} ({year_df['plays'].sum()} scrobbles)",
                expanded=(year == onthisday_df["year"].max()),
            ):
                st.dataframe(year_df[["artist", "track", "plays"]], hide_index=True, width='stretch')
