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

tab_overview, tab_top, tab_trends, tab_onthisday, tab_yir, tab_deepdives = st.tabs([
    "Overview", "Top tracks/artists", "Trends", "On this day", "Year in review", "Deep dives"
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

# ── Tab 5: Year in review ─────────────────────────────────────────────────────

with tab_yir:
    yir_years_df = query_df("""
        SELECT DISTINCT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS yr
        FROM scrobbles
        GROUP BY yr
        HAVING COUNT(DISTINCT (played_at AT TIME ZONE 'Europe/Amsterdam')::date) >= 30
        ORDER BY yr DESC
    """)
    yir_years = yir_years_df["yr"].tolist()
    selected_yr = st.selectbox("Year", yir_years, index=0, key="yir_year")
    prev_yr = selected_yr - 1

    metrics_df = query_df_params("""
        WITH filtered AS (
            SELECT
                EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS yr,
                a.name AS artist_name,
                t.title AS track_title,
                DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS play_date
            FROM scrobbles s
            JOIN tracks t ON t.id = s.track_id
            JOIN artists a ON a.id = t.artist_id
            WHERE source = 'lastfm'
              AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') IN (%s, %s)
        )
        SELECT
            COUNT(*) FILTER (WHERE yr = %s)                                        AS scrobbles_curr,
            COUNT(*) FILTER (WHERE yr = %s)                                        AS scrobbles_prev,
            COUNT(DISTINCT (artist_name || '|||' || track_title)) FILTER (WHERE yr = %s) AS tracks_curr,
            COUNT(DISTINCT (artist_name || '|||' || track_title)) FILTER (WHERE yr = %s) AS tracks_prev,
            COUNT(DISTINCT artist_name) FILTER (WHERE yr = %s)                     AS artists_curr,
            COUNT(DISTINCT artist_name) FILTER (WHERE yr = %s)                     AS artists_prev,
            COUNT(DISTINCT play_date) FILTER (WHERE yr = %s)                       AS days_curr,
            COUNT(DISTINCT play_date) FILTER (WHERE yr = %s)                       AS days_prev
        FROM filtered
    """, (selected_yr, prev_yr,
          selected_yr, prev_yr,
          selected_yr, prev_yr,
          selected_yr, prev_yr,
          selected_yr, prev_yr))

    row = metrics_df.iloc[0]

    def _delta(curr, prev):
        return int(curr - prev) if prev > 0 else None

    ycol1, ycol2, ycol3, ycol4 = st.columns(4)
    ycol1.metric("Total scrobbles",  f"{int(row['scrobbles_curr']):,}",  delta=_delta(row['scrobbles_curr'],  row['scrobbles_prev']))
    ycol2.metric("Unique tracks",    f"{int(row['tracks_curr']):,}",     delta=_delta(row['tracks_curr'],     row['tracks_prev']))
    ycol3.metric("Unique artists",   f"{int(row['artists_curr']):,}",    delta=_delta(row['artists_curr'],    row['artists_prev']))
    ycol4.metric("Listening days",   f"{int(row['days_curr']):,}",       delta=_delta(row['days_curr'],       row['days_prev']))

    st.subheader("Top 10 tracks")
    top10_tracks_df = query_df_params("""
        SELECT a.name AS artist, t.title AS track, COUNT(*) AS plays
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE source = 'lastfm'
          AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
        GROUP BY a.name, t.title
        ORDER BY plays DESC
        LIMIT 10
    """, (selected_yr,))
    top10_tracks_df = top10_tracks_df.rename(columns={"artist": "Artist", "track": "Track", "plays": "Plays"})
    top10_tracks_df.insert(0, "Rank", range(1, len(top10_tracks_df) + 1))
    st.dataframe(top10_tracks_df[["Rank", "Track", "Artist", "Plays"]], hide_index=True, width='stretch')

    st.subheader("Top 10 artists")
    top10_artists_df = query_df_params("""
        SELECT a.name AS artist, COUNT(*) AS plays
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE source = 'lastfm'
          AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
        GROUP BY a.name
        ORDER BY plays DESC
        LIMIT 10
    """, (selected_yr,))
    top10_artists_df = top10_artists_df.rename(columns={"artist": "Artist", "plays": "Plays"})
    top10_artists_df.insert(0, "Rank", range(1, len(top10_artists_df) + 1))
    st.dataframe(top10_artists_df[["Rank", "Artist", "Plays"]], hide_index=True, width='stretch')

    st.subheader("Monthly distribution")
    monthly_yr_df = query_df_params("""
        SELECT
            DATE_TRUNC('month', played_at AT TIME ZONE 'Europe/Amsterdam') AS month_d,
            COUNT(*) AS plays
        FROM scrobbles
        WHERE source = 'lastfm'
          AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
        GROUP BY month_d
        ORDER BY month_d
    """, (selected_yr,))
    monthly_yr_df["month_d"] = pd.to_datetime(monthly_yr_df["month_d"])

    monthly_yr_chart = alt.Chart(monthly_yr_df).mark_bar().encode(
        x=alt.X("month_d:T", title="Month"),
        y=alt.Y("plays:Q", title="Scrobbles"),
        tooltip=["month_d:T", "plays:Q"],
    ).properties(height=300)
    st.altair_chart(monthly_yr_chart, use_container_width=True)

    if not monthly_yr_df.empty:
        biggest_idx = int(monthly_yr_df["plays"].idxmax())
        biggest_month_d = monthly_yr_df.loc[biggest_idx, "month_d"]
        biggest_n = int(monthly_yr_df.loc[biggest_idx, "plays"])
        biggest_month_name = pd.to_datetime(biggest_month_d).strftime("%B")

        new_artists_df = query_df_params("""
            WITH first_plays AS (
                SELECT a.name AS artist_name,
                       MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first_play
                FROM scrobbles s
                JOIN tracks t ON t.id = s.track_id
                JOIN artists a ON a.id = t.artist_id
                WHERE source = 'lastfm'
                GROUP BY a.name
            )
            SELECT COUNT(*) AS new_artists
            FROM first_plays
            WHERE EXTRACT(YEAR FROM first_play) = %s
        """, (selected_yr,))
        new_artists_n = int(new_artists_df.iloc[0]["new_artists"])

        st.caption(
            f"Biggest month: **{biggest_month_name} {selected_yr}** ({biggest_n:,} scrobbles)"
            f"  ·  First discoveries: **{new_artists_n:,} new artists** scrobbled for the first time this year"
        )

# ── Tab 6: Deep dives ─────────────────────────────────────────────────────────

with tab_deepdives:
    st.subheader("Artist battle")

    top200_df = query_df("""
        SELECT a.name AS artist, COUNT(*) AS plays
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE source = 'lastfm'
        GROUP BY a.name
        ORDER BY plays DESC
        LIMIT 200
    """)
    artist_list = top200_df["artist"].tolist()

    bcol1, bcol2 = st.columns(2)
    with bcol1:
        artist_a = st.selectbox("Artist A", artist_list, index=0, key="battle_artist_a")
    with bcol2:
        artist_b = st.selectbox("Artist B", artist_list, index=1, key="battle_artist_b")

    battle_df = query_df_params("""
        WITH monthly AS (
            SELECT
                a.name AS artist,
                DATE_TRUNC('month', played_at AT TIME ZONE 'Europe/Amsterdam') AS month_d,
                COUNT(*) AS plays
            FROM scrobbles s
            JOIN tracks t ON t.id = s.track_id
            JOIN artists a ON a.id = t.artist_id
            WHERE source = 'lastfm'
              AND a.name IN (%s, %s)
            GROUP BY a.name, month_d
        )
        SELECT
            artist,
            month_d,
            plays,
            SUM(plays) OVER (PARTITION BY artist ORDER BY month_d) AS cumulative_plays
        FROM monthly
        ORDER BY artist, month_d
    """, (artist_a, artist_b))
    battle_df["month_d"] = pd.to_datetime(battle_df["month_d"])

    battle_chart = alt.Chart(battle_df).mark_line(point=True).encode(
        x=alt.X("month_d:T", title="Month"),
        y=alt.Y("cumulative_plays:Q", title="Cumulative plays"),
        color=alt.Color("artist:N", legend=alt.Legend(title="Artist")),
        tooltip=["artist:N", "month_d:T", "cumulative_plays:Q"],
    ).properties(height=350)
    st.altair_chart(battle_chart, use_container_width=True)

    artist_info_df = query_df_params("""
        SELECT
            a.name AS artist,
            COUNT(*) AS plays,
            MIN(DATE(played_at AT TIME ZONE 'Europe/Amsterdam')) AS first_play_date
        FROM scrobbles s
        JOIN tracks t ON t.id = s.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE source = 'lastfm'
          AND a.name IN (%s, %s)
        GROUP BY a.name
    """, (artist_a, artist_b))

    info_a = artist_info_df[artist_info_df["artist"] == artist_a]
    info_b = artist_info_df[artist_info_df["artist"] == artist_b]

    mc1, mc2, mc3, mc4 = st.columns(4)
    mc1.metric(f"{artist_a} plays",      f"{int(info_a['plays'].iloc[0]):,}"            if not info_a.empty else "—")
    mc2.metric(f"{artist_b} plays",      f"{int(info_b['plays'].iloc[0]):,}"            if not info_b.empty else "—")
    mc3.metric(f"{artist_a} first play", str(info_a['first_play_date'].iloc[0])         if not info_a.empty else "—")
    mc4.metric(f"{artist_b} first play", str(info_b['first_play_date'].iloc[0])         if not info_b.empty else "—")

    st.divider()

    st.subheader("Discovery rate")

    discovery_df = query_df("""
        WITH artist_firsts AS (
            SELECT
                a.name AS artist_name,
                MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first_play
            FROM scrobbles s
            JOIN tracks t ON t.id = s.track_id
            JOIN artists a ON a.id = t.artist_id
            WHERE source = 'lastfm'
            GROUP BY a.name
        ),
        track_firsts AS (
            SELECT
                a.name AS artist_name,
                t.title AS track_title,
                MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first_play
            FROM scrobbles s
            JOIN tracks t ON t.id = s.track_id
            JOIN artists a ON a.id = t.artist_id
            WHERE source = 'lastfm'
            GROUP BY a.name, t.title
        ),
        artist_counts AS (
            SELECT
                DATE_TRUNC('month', first_play) AS month_d,
                COUNT(*) AS cnt,
                'New artists' AS series
            FROM artist_firsts
            GROUP BY month_d
        ),
        track_counts AS (
            SELECT
                DATE_TRUNC('month', first_play) AS month_d,
                COUNT(*) AS cnt,
                'New tracks' AS series
            FROM track_firsts
            GROUP BY month_d
        )
        SELECT month_d, cnt, series FROM artist_counts
        UNION ALL
        SELECT month_d, cnt, series FROM track_counts
        ORDER BY series, month_d
    """)
    discovery_df["month_d"] = pd.to_datetime(discovery_df["month_d"])

    discovery_chart = alt.Chart(discovery_df).mark_line(point=True).encode(
        x=alt.X("month_d:T", title="Month"),
        y=alt.Y("cnt:Q", title="Count"),
        color=alt.Color("series:N", legend=alt.Legend(title="Series")),
        tooltip=["series:N", "month_d:T", "cnt:Q"],
    ).properties(height=350)
    st.altair_chart(discovery_chart, use_container_width=True)

    total_artists_disc = int(discovery_df[discovery_df["series"] == "New artists"]["cnt"].sum())
    total_tracks_disc  = int(discovery_df[discovery_df["series"] == "New tracks"]["cnt"].sum())
    st.caption(
        f"Total artists discovered: **{total_artists_disc:,}** · Total unique tracks scrobbled: **{total_tracks_disc:,}**"
    )
