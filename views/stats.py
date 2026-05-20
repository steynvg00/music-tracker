"""Stats page — 10 read-only tabs with scrobble statistics."""

import altair as alt
import pandas as pd
import streamlit as st
from datetime import datetime

from lib.db import get_connection


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


st.title("🎵 music-tracker")
st.caption("Personal scrobble stats, threshold playlists, and listening patterns.")

today = datetime.now().date()

tab_overview, tab_top, tab_trends, tab_onthisday, tab_yir, tab_deepdives, tab_personality, tab_records, tab_highlights, tab_spotify = st.tabs([
    "Overview", "Top tracks/artists", "Trends", "On this day",
    "Year in review", "Deep dives", "Personality", "Records", "Highlights", "Spotify",
])

# ── Tab 1: Overview ───────────────────────────────────────────────────────────

with tab_overview:
    col1, col2, col3, col4 = st.columns(4)

    total_scrobbles = query_df(
        "SELECT COUNT(*) AS n FROM unified_plays"
    ).iloc[0]["n"]
    unique_tracks = query_df(
        "SELECT COUNT(DISTINCT track) AS n FROM unified_plays"
    ).iloc[0]["n"]
    unique_artists = query_df(
        "SELECT COUNT(DISTINCT artist) AS n FROM unified_plays"
    ).iloc[0]["n"]
    date_range_df = query_df(
        "SELECT MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first, MAX(played_at AT TIME ZONE 'Europe/Amsterdam') AS last FROM unified_plays"
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
        "SELECT COUNT(DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam')) AS n FROM unified_plays"
    ).iloc[0]["n"]

    current_streak_df = query_df("""
        WITH days AS (
            SELECT DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS d
            FROM unified_plays
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
            FROM unified_plays
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
        FROM unified_plays
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
        SELECT artist, track, COUNT(*) AS plays
        FROM unified_plays
        WHERE TRUE {period_filter}
        GROUP BY artist, track
        ORDER BY plays DESC
        LIMIT 50
    """
    st.subheader("Top 50 tracks")
    st.dataframe(query_df(top_tracks_sql), hide_index=True, width='stretch')

    st.divider()

    top_artists_sql = f"""
        SELECT artist, COUNT(*) AS plays
        FROM unified_plays
        WHERE TRUE {period_filter}
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 50
    """
    st.subheader("Top 50 artists")
    st.dataframe(query_df(top_artists_sql), hide_index=True, width='stretch')

# ── Tab 3: Trends ─────────────────────────────────────────────────────────────

with tab_trends:
    years_df = query_df(
        "SELECT DISTINCT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS y FROM unified_plays ORDER BY y DESC"
    )
    years = years_df["y"].tolist()
    selected_year = st.selectbox("Year", years, index=0)

    st.subheader("Daily scrobbles")

    cal_df = query_df_params(
        """
        SELECT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS day, COUNT(*) AS plays
        FROM unified_plays
        WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
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
        FROM unified_plays
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
               artist, track, COUNT(*) AS plays
        FROM unified_plays
        WHERE EXTRACT(MONTH FROM played_at AT TIME ZONE 'Europe/Amsterdam') = EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'Europe/Amsterdam'))
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
        FROM unified_plays
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
                artist AS artist_name,
                track AS track_title,
                DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS play_date
            FROM unified_plays
            WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') IN (%s, %s)
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
        SELECT artist, track, COUNT(*) AS plays
        FROM unified_plays
        WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
        GROUP BY artist, track
        ORDER BY plays DESC
        LIMIT 10
    """, (selected_yr,))
    top10_tracks_df = top10_tracks_df.rename(columns={"artist": "Artist", "track": "Track", "plays": "Plays"})
    top10_tracks_df.insert(0, "Rank", range(1, len(top10_tracks_df) + 1))
    st.dataframe(top10_tracks_df[["Rank", "Track", "Artist", "Plays"]], hide_index=True, width='stretch')

    st.subheader("Top 10 artists")
    top10_artists_df = query_df_params("""
        SELECT artist, COUNT(*) AS plays
        FROM unified_plays
        WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
        GROUP BY artist
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
        FROM unified_plays
        WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = %s
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
                SELECT artist AS artist_name,
                       MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first_play
                FROM unified_plays
                GROUP BY artist
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
        SELECT artist, COUNT(*) AS plays
        FROM unified_plays
        GROUP BY artist
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
                artist,
                DATE_TRUNC('month', played_at AT TIME ZONE 'Europe/Amsterdam') AS month_d,
                COUNT(*) AS plays
            FROM unified_plays
            WHERE artist IN (%s, %s)
            GROUP BY artist, month_d
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
            artist,
            COUNT(*) AS plays,
            MIN(DATE(played_at AT TIME ZONE 'Europe/Amsterdam')) AS first_play_date
        FROM unified_plays
        WHERE artist IN (%s, %s)
        GROUP BY artist
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
                artist AS artist_name,
                MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first_play
            FROM unified_plays
            GROUP BY artist
        ),
        track_firsts AS (
            SELECT
                artist AS artist_name,
                track AS track_title,
                MIN(played_at AT TIME ZONE 'Europe/Amsterdam') AS first_play
            FROM unified_plays
            GROUP BY artist, track
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

# ── Tab 7: Personality ────────────────────────────────────────────────────────

with tab_personality:
    # ── Section A: Album depth ────────────────────────────────────────────────
    st.subheader("Album depth")
    st.caption("Top 20 albums by number of unique tracks you've scrobbled. Reveals which albums you've genuinely explored vs the ones where you only play the hits.")

    album_depth_df = query_df("""
        SELECT
            album,
            artist,
            COUNT(DISTINCT track) AS unique_tracks,
            COUNT(*) AS total_plays
        FROM unified_plays
        WHERE album IS NOT NULL AND album <> ''
        GROUP BY album, artist
        ORDER BY unique_tracks DESC, total_plays DESC
        LIMIT 20
    """)
    album_depth_df = album_depth_df.rename(columns={
        "album": "Album", "artist": "Artist",
        "unique_tracks": "Unique tracks", "total_plays": "Total plays",
    })
    album_depth_df.insert(0, "Rank", range(1, len(album_depth_df) + 1))
    st.dataframe(album_depth_df[["Rank", "Album", "Artist", "Unique tracks", "Total plays"]], hide_index=True, width='stretch')

    st.divider()

    # ── Section B: Weekend vs weekday ─────────────────────────────────────────
    st.subheader("Weekend vs weekday")
    st.caption("Top 10 artists for weekend days (Sat–Sun) and weekday days (Mon–Fri), side by side.")

    dow_split_df = query_df("""
        WITH labeled AS (
            SELECT
                artist,
                CASE
                    WHEN EXTRACT(DOW FROM played_at AT TIME ZONE 'Europe/Amsterdam') IN (0, 6) THEN 'weekend'
                    ELSE 'weekday'
                END AS day_type
            FROM unified_plays
        ),
        ranked AS (
            SELECT
                day_type, artist,
                COUNT(*) AS plays,
                ROW_NUMBER() OVER (PARTITION BY day_type ORDER BY COUNT(*) DESC) AS rnk
            FROM labeled
            GROUP BY day_type, artist
        )
        SELECT day_type, rnk, artist, plays
        FROM ranked
        WHERE rnk <= 10
        ORDER BY day_type, rnk
    """)

    wknd_df = dow_split_df[dow_split_df["day_type"] == "weekend"][["rnk", "artist", "plays"]].rename(
        columns={"rnk": "Rank", "artist": "Artist", "plays": "Plays"}
    )
    wkdy_df = dow_split_df[dow_split_df["day_type"] == "weekday"][["rnk", "artist", "plays"]].rename(
        columns={"rnk": "Rank", "artist": "Artist", "plays": "Plays"}
    )

    dow_col1, dow_col2 = st.columns(2)
    with dow_col1:
        st.markdown("**Weekend (Sat–Sun)**")
        st.dataframe(wknd_df, hide_index=True, width='stretch')
    with dow_col2:
        st.markdown("**Weekday (Mon–Fri)**")
        st.dataframe(wkdy_df, hide_index=True, width='stretch')

    st.divider()

    # ── Section C: Listening fingerprint ─────────────────────────────────────
    st.subheader("Listening fingerprint")
    st.caption("Your characteristic listening signature.")

    fingerprint_df = query_df("""
        WITH totals AS (
            SELECT
                COUNT(*) AS total_plays,
                COUNT(DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam')) AS total_days
            FROM unified_plays
        ),
        hour_top AS (
            SELECT EXTRACT(HOUR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS hour_d
            FROM unified_plays
            GROUP BY hour_d
            ORDER BY COUNT(*) DESC
            LIMIT 1
        ),
        dow_top AS (
            SELECT EXTRACT(DOW FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS dow_d
            FROM unified_plays
            GROUP BY dow_d
            ORDER BY COUNT(*) DESC
            LIMIT 1
        )
        SELECT t.total_plays, t.total_days, h.hour_d AS peak_hour_d, d.dow_d AS peak_dow_d
        FROM totals t, hour_top h, dow_top d
    """)

    fp = fingerprint_df.iloc[0]
    DOW_NAMES = {0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday",
                 4: "Thursday", 5: "Friday", 6: "Saturday"}
    peak_hour_str = f"{int(fp['peak_hour_d']):02d}:00"
    peak_dow_str  = DOW_NAMES[int(fp["peak_dow_d"])]
    avg_day_str   = f"{float(fp['total_plays']) / float(fp['total_days']):.1f}" if fp["total_days"] > 0 else "—"
    listen_days_str = f"{int(fp['total_days']):,}"

    fp_col1, fp_col2, fp_col3, fp_col4 = st.columns(4)
    fp_col1.metric("Peak hour",             peak_hour_str)
    fp_col2.metric("Peak weekday",          peak_dow_str)
    fp_col3.metric("Avg per listening day", avg_day_str)
    fp_col4.metric("Listening days",        listen_days_str)

# ── Tab 8: Records ────────────────────────────────────────────────────────────

with tab_records:
    # ── Section A: Biggest single day ─────────────────────────────────────────
    st.subheader("Biggest single day")

    biggest_day_df = query_df("""
        WITH daily AS (
            SELECT
                (played_at AT TIME ZONE 'Europe/Amsterdam')::date AS day_d,
                COUNT(*) AS plays
            FROM unified_plays
            GROUP BY day_d
        )
        SELECT day_d, plays FROM daily ORDER BY plays DESC LIMIT 1
    """)

    if not biggest_day_df.empty:
        bd = biggest_day_df.iloc[0]
        bd_date_str = pd.to_datetime(bd["day_d"]).strftime("%A, %-d %B %Y")
        bd_plays    = int(bd["plays"])

        bd_col1, bd_col2 = st.columns(2)
        with bd_col1:
            st.metric("Date",       bd_date_str)
            st.metric("Scrobbles",  f"{bd_plays:,}")
        with bd_col2:
            top5_df = query_df_params("""
                SELECT track, artist, COUNT(*) AS plays
                FROM unified_plays
                WHERE (played_at AT TIME ZONE 'Europe/Amsterdam')::date = %s
                GROUP BY track, artist
                ORDER BY plays DESC
                LIMIT 5
            """, (bd["day_d"],))
            top5_df = top5_df.rename(columns={"track": "Track", "artist": "Artist", "plays": "Plays"})
            top5_df.insert(0, "Rank", range(1, len(top5_df) + 1))
            st.dataframe(top5_df[["Rank", "Track", "Artist", "Plays"]], hide_index=True, width='stretch')

    st.divider()

    # ── Section B: Longest gap ────────────────────────────────────────────────
    st.subheader("Longest gap")
    st.caption("Your longest silence between scrobbles.")

    gap_df = query_df("""
        WITH gaps AS (
            SELECT
                played_at,
                artist,
                track,
                LAG(played_at) OVER (ORDER BY played_at) AS prev_played,
                LAG(artist)    OVER (ORDER BY played_at) AS prev_artist,
                LAG(track)     OVER (ORDER BY played_at) AS prev_track,
                played_at - LAG(played_at) OVER (ORDER BY played_at) AS gap_duration
            FROM unified_plays
        )
        SELECT played_at, artist, track, prev_played, prev_artist, prev_track, gap_duration
        FROM gaps
        WHERE prev_played IS NOT NULL
        ORDER BY gap_duration DESC
        LIMIT 1
    """)

    if not gap_df.empty:
        gr       = gap_df.iloc[0]
        gap_td   = pd.Timedelta(gr["gap_duration"])
        gap_str  = f"{gap_td.days:,} days, {gap_td.seconds // 3600} hours"
        prev_dt  = pd.to_datetime(gr["prev_played"]).strftime("%Y-%m-%d")
        after_dt = pd.to_datetime(gr["played_at"]).strftime("%Y-%m-%d")

        gc1, gc2, gc3 = st.columns(3)
        with gc1:
            st.metric("Last before gap", prev_dt)
            st.caption(f"{gr['prev_track']} — {gr['prev_artist']}")
        with gc2:
            st.metric("Gap duration", gap_str)
        with gc3:
            st.metric("First after gap", after_dt)
            st.caption(f"{gr['track']} — {gr['artist']}")

    st.divider()

    # ── Section C: Scrobble milestones ────────────────────────────────────────
    st.subheader("Scrobble milestones")
    st.caption("The scrobble that marked each landmark on your listening history.")

    _MILESTONE_NS = (1, 1000, 5000, 10000, 25000, 50000, 100000)
    _ORDINALS = {
        1: "1st", 1000: "1,000th", 5000: "5,000th", 10000: "10,000th",
        25000: "25,000th", 50000: "50,000th", 100000: "100,000th",
    }

    milestones_df = query_df(f"""
        WITH numbered AS (
            SELECT
                ROW_NUMBER() OVER (ORDER BY played_at) AS n,
                played_at,
                artist,
                track
            FROM unified_plays
        )
        SELECT n, played_at, artist, track
        FROM numbered
        WHERE n IN ({', '.join(str(x) for x in _MILESTONE_NS)})
        ORDER BY n
    """)

    if not milestones_df.empty:
        milestones_df["N"]    = milestones_df["n"].apply(lambda x: _ORDINALS.get(int(x), f"{int(x):,}th"))
        milestones_df["Date"] = pd.to_datetime(milestones_df["played_at"]).dt.strftime("%Y-%m-%d")
        milestones_df = milestones_df.rename(columns={"track": "Track", "artist": "Artist"})
        st.dataframe(milestones_df[["N", "Date", "Track", "Artist"]], hide_index=True, width='stretch')

    st.divider()

    # ── Section D: Top artist of each year ────────────────────────────────────
    st.subheader("Top artist of each year")

    top_by_year_df = query_df("""
        WITH yearly AS (
            SELECT
                EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year_d,
                artist,
                COUNT(*) AS plays,
                ROW_NUMBER() OVER (
                    PARTITION BY EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int
                    ORDER BY COUNT(*) DESC
                ) AS rnk
            FROM unified_plays
            GROUP BY EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int, artist
        )
        SELECT year_d AS "Year", artist AS "Top artist", plays AS "Plays"
        FROM yearly
        WHERE rnk = 1
        ORDER BY year_d DESC
    """)
    st.dataframe(top_by_year_df, hide_index=True, width='stretch')

# ── Tab 9: Highlights ─────────────────────────────────────────────────────────

with tab_highlights:
    # ── Section A: Period comparison ──────────────────────────────────────────
    st.subheader("Period comparison")
    st.caption("Compare any two years or months head-to-head.")

    hl_mode = st.radio("Compare by", ["Year", "Month"], horizontal=True, key="hl_mode")

    hl_years_df = query_df(
        "SELECT DISTINCT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS y "
        "FROM unified_plays ORDER BY y DESC"
    )
    hl_years = hl_years_df["y"].tolist()

    hl_months_df = query_df(
        "SELECT DISTINCT TO_CHAR(played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS m "
        "FROM unified_plays ORDER BY m DESC"
    )
    hl_months = hl_months_df["m"].tolist()

    hl_col_a, hl_col_b = st.columns(2)

    if hl_mode == "Year":
        with hl_col_a:
            hl_a = st.selectbox("Period A", hl_years, index=0, key="hl_year_a")
        with hl_col_b:
            hl_b = st.selectbox("Period B", hl_years, index=min(1, len(hl_years) - 1), key="hl_year_b")

        cmp_df = query_df_params("""
            WITH filtered AS (
                SELECT
                    EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS period_key,
                    artist AS artist_name,
                    track AS track_title,
                    DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS play_date
                FROM unified_plays
                WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') IN (%s, %s)
            )
            SELECT
                COUNT(*) FILTER (WHERE period_key = %s) AS scrobbles_a,
                COUNT(*) FILTER (WHERE period_key = %s) AS scrobbles_b,
                COUNT(DISTINCT (artist_name || '|||' || track_title)) FILTER (WHERE period_key = %s) AS tracks_a,
                COUNT(DISTINCT (artist_name || '|||' || track_title)) FILTER (WHERE period_key = %s) AS tracks_b,
                COUNT(DISTINCT artist_name) FILTER (WHERE period_key = %s) AS artists_a,
                COUNT(DISTINCT artist_name) FILTER (WHERE period_key = %s) AS artists_b,
                COUNT(DISTINCT play_date) FILTER (WHERE period_key = %s) AS days_a,
                COUNT(DISTINCT play_date) FILTER (WHERE period_key = %s) AS days_b
            FROM filtered
        """, (hl_a, hl_b, hl_a, hl_b, hl_a, hl_b, hl_a, hl_b, hl_a, hl_b))
    else:
        with hl_col_a:
            hl_a = st.selectbox("Period A", hl_months, index=0, key="hl_month_a")
        with hl_col_b:
            hl_b = st.selectbox("Period B", hl_months, index=min(1, len(hl_months) - 1), key="hl_month_b")

        cmp_df = query_df_params("""
            WITH filtered AS (
                SELECT
                    TO_CHAR(played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS period_key,
                    artist AS artist_name,
                    track AS track_title,
                    DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS play_date
                FROM unified_plays
                WHERE TO_CHAR(played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') IN (%s, %s)
            )
            SELECT
                COUNT(*) FILTER (WHERE period_key = %s) AS scrobbles_a,
                COUNT(*) FILTER (WHERE period_key = %s) AS scrobbles_b,
                COUNT(DISTINCT (artist_name || '|||' || track_title)) FILTER (WHERE period_key = %s) AS tracks_a,
                COUNT(DISTINCT (artist_name || '|||' || track_title)) FILTER (WHERE period_key = %s) AS tracks_b,
                COUNT(DISTINCT artist_name) FILTER (WHERE period_key = %s) AS artists_a,
                COUNT(DISTINCT artist_name) FILTER (WHERE period_key = %s) AS artists_b,
                COUNT(DISTINCT play_date) FILTER (WHERE period_key = %s) AS days_a,
                COUNT(DISTINCT play_date) FILTER (WHERE period_key = %s) AS days_b
            FROM filtered
        """, (hl_a, hl_b, hl_a, hl_b, hl_a, hl_b, hl_a, hl_b, hl_a, hl_b))

    if not cmp_df.empty:
        cmp_row = cmp_df.iloc[0]
        cmp_c1, cmp_c2, cmp_c3, cmp_c4 = st.columns(4)
        cmp_c1.metric("Scrobbles",      f"{int(cmp_row['scrobbles_a']):,}", delta=int(cmp_row['scrobbles_a'] - cmp_row['scrobbles_b']))
        cmp_c2.metric("Unique tracks",  f"{int(cmp_row['tracks_a']):,}",   delta=int(cmp_row['tracks_a']   - cmp_row['tracks_b']))
        cmp_c3.metric("Unique artists", f"{int(cmp_row['artists_a']):,}",  delta=int(cmp_row['artists_a']  - cmp_row['artists_b']))
        cmp_c4.metric("Listening days", f"{int(cmp_row['days_a']):,}",     delta=int(cmp_row['days_a']     - cmp_row['days_b']))
        st.caption(f"Period A: **{hl_a}** · Period B: **{hl_b}** · delta = A − B")

    st.divider()

    # ── Section B: Achievements ───────────────────────────────────────────────
    st.subheader("Achievements")

    ach_first = query_df("""
        SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date AS first_d,
               artist, track
        FROM unified_plays
        ORDER BY played_at ASC LIMIT 1
    """)
    ach_streak = query_df("""
        WITH days AS (
            SELECT DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS d
            FROM unified_plays
        ),
        grps AS (
            SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM days
        ),
        streaks AS (
            SELECT MIN(d) AS start_d, MAX(d) AS end_d, COUNT(*) AS len FROM grps GROUP BY grp
        )
        SELECT len, start_d, end_d FROM streaks ORDER BY len DESC LIMIT 1
    """)
    ach_marathon = query_df("""
        SELECT (played_at AT TIME ZONE 'Europe/Amsterdam')::date AS day_d, COUNT(*) AS plays
        FROM unified_plays
        GROUP BY day_d ORDER BY plays DESC LIMIT 1
    """)
    ach_top_artist = query_df("""
        SELECT artist, COUNT(*) AS plays
        FROM unified_plays
        GROUP BY artist ORDER BY plays DESC LIMIT 1
    """)
    ach_top_track = query_df("""
        SELECT artist, track, COUNT(*) AS plays
        FROM unified_plays
        GROUP BY artist, track ORDER BY plays DESC LIMIT 1
    """)
    ach_best_year = query_df("""
        SELECT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year_d, COUNT(*) AS plays
        FROM unified_plays
        GROUP BY year_d ORDER BY plays DESC LIMIT 1
    """)
    ach_discovery = query_df("""
        WITH firsts AS (
            SELECT artist AS artist_name,
                   EXTRACT(YEAR FROM MIN(played_at AT TIME ZONE 'Europe/Amsterdam'))::int AS first_yr
            FROM unified_plays
            GROUP BY artist
        )
        SELECT first_yr AS year_d, COUNT(*) AS new_artists
        FROM firsts GROUP BY first_yr ORDER BY new_artists DESC LIMIT 1
    """)
    ach_peak_hour = query_df("""
        SELECT EXTRACT(HOUR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS hour_d, COUNT(*) AS plays
        FROM unified_plays
        GROUP BY hour_d ORDER BY plays DESC LIMIT 1
    """)

    def _ach_card(col, emoji, name, value, detail):
        with col:
            with st.container(border=True):
                st.markdown(f"**{emoji} {name}**")
                st.markdown(f"### {value}")
                st.caption(detail)

    row1_cols = st.columns(4)
    row2_cols = st.columns(4)

    _ach_card(
        row1_cols[0], "🎵", "First scrobble",
        str(ach_first.iloc[0]["first_d"]) if not ach_first.empty else "—",
        f"{ach_first.iloc[0]['track']} — {ach_first.iloc[0]['artist']}" if not ach_first.empty else "",
    )
    _ach_card(
        row1_cols[1], "🔥", "Longest streak",
        f"{int(ach_streak.iloc[0]['len']):,} days" if not ach_streak.empty else "—",
        f"{ach_streak.iloc[0]['start_d']} → {ach_streak.iloc[0]['end_d']}" if not ach_streak.empty else "",
    )
    _ach_card(
        row1_cols[2], "🎧", "Marathon day",
        f"{int(ach_marathon.iloc[0]['plays']):,} plays" if not ach_marathon.empty else "—",
        str(ach_marathon.iloc[0]["day_d"]) if not ach_marathon.empty else "",
    )
    _ach_card(
        row1_cols[3], "🏆", "Top artist",
        ach_top_artist.iloc[0]["artist"] if not ach_top_artist.empty else "—",
        f"{int(ach_top_artist.iloc[0]['plays']):,} plays" if not ach_top_artist.empty else "",
    )
    _ach_card(
        row2_cols[0], "🎶", "Top track",
        ach_top_track.iloc[0]["track"] if not ach_top_track.empty else "—",
        f"{ach_top_track.iloc[0]['artist']} · {int(ach_top_track.iloc[0]['plays']):,} plays" if not ach_top_track.empty else "",
    )
    _ach_card(
        row2_cols[1], "📅", "Best year",
        str(int(ach_best_year.iloc[0]["year_d"])) if not ach_best_year.empty else "—",
        f"{int(ach_best_year.iloc[0]['plays']):,} scrobbles" if not ach_best_year.empty else "",
    )
    _ach_card(
        row2_cols[2], "🔭", "Discovery year",
        str(int(ach_discovery.iloc[0]["year_d"])) if not ach_discovery.empty else "—",
        f"{int(ach_discovery.iloc[0]['new_artists']):,} new artists" if not ach_discovery.empty else "",
    )
    _ach_card(
        row2_cols[3], "🕛", "Peak hour",
        f"{int(ach_peak_hour.iloc[0]['hour_d']):02d}:00" if not ach_peak_hour.empty else "—",
        f"{int(ach_peak_hour.iloc[0]['plays']):,} plays" if not ach_peak_hour.empty else "",
    )

    st.divider()

    # ── Section C: Artist rank race ───────────────────────────────────────────
    st.subheader("Artist rank race")
    st.caption("Where your top 10 all-time artists ranked each year.")

    race_df = query_df("""
        WITH yearly AS (
            SELECT
                EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year_d,
                artist,
                COUNT(*) AS plays
            FROM unified_plays
            GROUP BY EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int, artist
        ),
        ranked_all AS (
            SELECT year_d, artist, plays,
                   ROW_NUMBER() OVER (PARTITION BY year_d ORDER BY plays DESC) AS rnk
            FROM yearly
        ),
        top10 AS (
            SELECT artist FROM (
                SELECT artist, SUM(plays) AS total_plays
                FROM yearly GROUP BY artist ORDER BY total_plays DESC LIMIT 10
            ) sub
        )
        SELECT r.year_d, r.artist, r.plays, r.rnk
        FROM ranked_all r
        JOIN top10 t ON t.artist = r.artist
        ORDER BY r.year_d, r.rnk
    """)

    if not race_df.empty:
        race_chart = alt.Chart(race_df).mark_line(point=True).encode(
            x=alt.X("year_d:O", title="Year"),
            y=alt.Y("rnk:Q", title="Rank",
                    scale=alt.Scale(domain=[1, 50], reverse=True),
                    axis=alt.Axis(tickMinStep=1)),
            color=alt.Color("artist:N", legend=alt.Legend(title="Artist")),
            tooltip=["year_d:O", "artist:N", "rnk:Q", "plays:Q"],
        ).properties(height=400)
        st.altair_chart(race_chart, use_container_width=True)

# ── Tab 10: Spotify ───────────────────────────────────────────────────────────

with tab_spotify:
    # ── Section 1: Overview metrics row ──────────────────────────────────────
    sp_overview_df = query_df("""
        SELECT
            COUNT(*) AS total_plays,
            ROUND(SUM(ms_played) / 3600000.0, 1) AS total_hours,
            MIN((played_at AT TIME ZONE 'Europe/Amsterdam')::date) AS first_d,
            MAX((played_at AT TIME ZONE 'Europe/Amsterdam')::date) AS last_d,
            COUNT(DISTINCT track_uri) AS distinct_tracks
        FROM spotify_plays
        WHERE track_uri IS NOT NULL
    """)

    sp_row = sp_overview_df.iloc[0]
    sp_date_range = (
        f"{sp_row['first_d']} → {sp_row['last_d']}"
        if sp_row["first_d"] and sp_row["last_d"]
        else "—"
    )

    sp_c1, sp_c2, sp_c3, sp_c4 = st.columns(4)
    sp_c1.metric("Total plays",      f"{int(sp_row['total_plays']):,}")
    sp_c2.metric("Total hours",      f"{float(sp_row['total_hours']):.1f} hrs")
    sp_c3.metric("Date range",       sp_date_range)
    sp_c4.metric("Distinct tracks",  f"{int(sp_row['distinct_tracks']):,}")

    st.divider()

    # ── Section 2: Listening time ─────────────────────────────────────────────
    st.subheader("Listening time")
    st.caption("Hours of music listened to, by year.")

    sp_hours_df = query_df("""
        SELECT
            EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year_d,
            ROUND(SUM(ms_played) / 3600000.0, 1) AS hours
        FROM spotify_plays
        WHERE track_uri IS NOT NULL
        GROUP BY year_d
        ORDER BY year_d
    """)

    sp_hours_chart = alt.Chart(sp_hours_df).mark_bar().encode(
        x=alt.X("year_d:O", title="Year"),
        y=alt.Y("hours:Q", title="Hours"),
        tooltip=["year_d:O", "hours:Q"],
    ).properties(height=300)
    st.altair_chart(sp_hours_chart, use_container_width=True)

    st.divider()

    # ── Section 3: Skip analysis ──────────────────────────────────────────────
    st.subheader("Skip analysis")
    st.caption("Skip rate and the tracks you skipped most often.")

    sp_skip_rate_df = query_df("""
        SELECT
            ROUND(100.0 * COUNT(*) FILTER (WHERE reason_end = 'fwdbtn') / COUNT(*), 1) AS skip_rate_pct
        FROM spotify_plays
        WHERE track_uri IS NOT NULL
    """)
    sp_skip_rate = float(sp_skip_rate_df.iloc[0]["skip_rate_pct"])
    st.metric("Overall skip rate", f"{sp_skip_rate:.1f}%")

    sp_skipped_df = query_df("""
        WITH t AS (
            SELECT
                track_uri,
                MAX(track_name) AS track_name,
                MAX(artist_name) AS artist_name,
                COUNT(*) AS plays,
                COUNT(*) FILTER (WHERE reason_end = 'fwdbtn') AS skips
            FROM spotify_plays
            WHERE track_uri IS NOT NULL
            GROUP BY track_uri
            HAVING COUNT(*) >= 10
        )
        SELECT
            track_name,
            artist_name,
            plays,
            skips,
            ROUND(100.0 * skips / plays, 1) AS skip_rate_pct
        FROM t
        WHERE skips > 0
        ORDER BY skip_rate_pct DESC, skips DESC
        LIMIT 20
    """)
    sp_skipped_df = sp_skipped_df.rename(columns={
        "track_name": "Track", "artist_name": "Artist",
        "plays": "Plays", "skips": "Skips", "skip_rate_pct": "Skip rate %",
    })
    sp_skipped_df.insert(0, "Rank", range(1, len(sp_skipped_df) + 1))
    st.dataframe(sp_skipped_df[["Rank", "Track", "Artist", "Plays", "Skips", "Skip rate %"]], hide_index=True)

    st.divider()

    # ── Section 4: Platform breakdown ─────────────────────────────────────────
    st.subheader("Platform breakdown")
    st.caption("Where you listen — by device family.")

    sp_platform_df = query_df("""
        SELECT
            CASE
                WHEN platform LIKE '%OS X%' OR platform LIKE '%Mac OS%' OR platform LIKE '%macOS%' THEN 'Mac'
                WHEN platform LIKE '%iOS%' OR platform LIKE '%iPhone%' OR platform LIKE '%iPad%' THEN 'iOS'
                WHEN platform LIKE '%Android%' THEN 'Android'
                WHEN platform LIKE '%Windows%' THEN 'Windows'
                WHEN platform LIKE '%WebPlayer%' OR platform ILIKE '%web%' THEN 'Web'
                WHEN platform IS NULL OR platform = '' THEN 'Unknown'
                ELSE 'Other'
            END AS platform_family,
            COUNT(*) AS plays
        FROM spotify_plays
        WHERE track_uri IS NOT NULL
        GROUP BY platform_family
        ORDER BY plays DESC
    """)

    sp_platform_total = sp_platform_df["plays"].sum()
    sp_platform_df["pct"] = (sp_platform_df["plays"] / sp_platform_total * 100).round(1)
    sp_platform_df["tooltip_label"] = (
        sp_platform_df["platform_family"]
        + ": "
        + sp_platform_df["plays"].apply(lambda x: f"{x:,}")
        + " ("
        + sp_platform_df["pct"].apply(lambda x: f"{x:.1f}%")
        + ")"
    )

    sp_donut = alt.Chart(sp_platform_df).mark_arc(innerRadius=60).encode(
        theta=alt.Theta("plays:Q"),
        color=alt.Color("platform_family:N", legend=alt.Legend(title="Platform")),
        tooltip=["platform_family:N", "plays:Q", "pct:Q"],
    ).properties(height=300)
    st.altair_chart(sp_donut, use_container_width=True)

    sp_pct_parts = " · ".join(
        f"{row['platform_family']}: {row['pct']:.1f}%"
        for _, row in sp_platform_df.iterrows()
    )
    st.caption(sp_pct_parts)

    st.divider()

    # ── Section 5: Shuffle behavior ───────────────────────────────────────────
    st.subheader("Shuffle behavior")
    st.caption("How often you let Spotify pick the order versus choosing yourself.")

    sp_shuffle_df = query_df("""
        SELECT
            EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year_d,
            ROUND(100.0 * COUNT(*) FILTER (WHERE shuffle = true) / COUNT(*), 1) AS shuffle_rate_pct
        FROM spotify_plays
        WHERE track_uri IS NOT NULL
        GROUP BY year_d
        ORDER BY year_d
    """)

    sp_shuffle_overall_df = query_df("""
        SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE shuffle = true) / COUNT(*), 1) AS shuffle_rate_pct
        FROM spotify_plays
        WHERE track_uri IS NOT NULL
    """)
    sp_shuffle_overall = float(sp_shuffle_overall_df.iloc[0]["shuffle_rate_pct"])
    st.metric("Shuffle rate", f"{sp_shuffle_overall:.1f}%")

    sp_shuffle_chart = alt.Chart(sp_shuffle_df).mark_line(point=True).encode(
        x=alt.X("year_d:O", title="Year"),
        y=alt.Y("shuffle_rate_pct:Q", title="Shuffle rate (%)",
                scale=alt.Scale(domain=[0, 100])),
        tooltip=["year_d:O", "shuffle_rate_pct:Q"],
    ).properties(height=300)
    st.altair_chart(sp_shuffle_chart, use_container_width=True)

    st.divider()

    # ── Section 6: End-of-play reasons ───────────────────────────────────────
    st.subheader("End-of-play reasons")
    st.caption("Why each play ended — finished naturally, skipped, paused, app closed.")

    sp_reasons_df = query_df("""
        WITH r AS (
            SELECT
                COALESCE(reason_end, '(null)') AS reason,
                COUNT(*) AS plays
            FROM spotify_plays
            WHERE track_uri IS NOT NULL
            GROUP BY reason_end
        )
        SELECT
            reason,
            plays,
            ROUND(100.0 * plays / SUM(plays) OVER (), 1) AS pct
        FROM r
        ORDER BY plays DESC
        LIMIT 10
    """)

    sp_reasons_chart = alt.Chart(sp_reasons_df).mark_bar().encode(
        y=alt.Y("reason:N", title="Reason", sort="-x"),
        x=alt.X("plays:Q", title="Plays"),
        tooltip=["reason:N", "plays:Q", "pct:Q"],
    ).properties(height=350)

    sp_reasons_text = alt.Chart(sp_reasons_df).mark_text(align="left", dx=4).encode(
        y=alt.Y("reason:N", sort="-x"),
        x=alt.X("plays:Q"),
        text=alt.Text("plays:Q", format=","),
    )

    st.altair_chart((sp_reasons_chart + sp_reasons_text), use_container_width=True)
