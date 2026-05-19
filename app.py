"""music-tracker dashboard — local Streamlit app for scrobble stats."""

import sys
sys.path.insert(0, ".")

import pandas as pd
import streamlit as st

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


# ── Header ────────────────────────────────────────────────────────────────────

st.title("🎵 music-tracker")
st.caption("Scrobble stats ingested from last.fm — top-line numbers and top 50 tracks / artists.")

# ── Metrics row ───────────────────────────────────────────────────────────────

col1, col2, col3, col4 = st.columns(4)

total_scrobbles = query_df("SELECT COUNT(*) AS n FROM scrobbles").iloc[0]["n"]
unique_tracks = query_df("SELECT COUNT(DISTINCT track_id) AS n FROM scrobbles").iloc[0]["n"]
unique_artists = query_df(
    "SELECT COUNT(DISTINCT t.artist_id) AS n FROM scrobbles s JOIN tracks t ON t.id = s.track_id"
).iloc[0]["n"]
date_range_df = query_df("SELECT MIN(played_at) AS first, MAX(played_at) AS last FROM scrobbles")
first_date = date_range_df.iloc[0]["first"]
last_date = date_range_df.iloc[0]["last"]
date_range = (
    f"{first_date:%Y-%m-%d} → {last_date:%Y-%m-%d}"
    if first_date and last_date
    else "—"
)

col1.metric("Total scrobbles", f"{total_scrobbles:,}")
col2.metric("Unique tracks", f"{unique_tracks:,}")
col3.metric("Unique artists", f"{unique_artists:,}")
col4.metric("Date range", date_range)

# ── Top 50 tracks ─────────────────────────────────────────────────────────────

st.divider()
st.subheader("Top 50 tracks")

top_tracks_sql = """
SELECT a.name AS artist, t.title AS track, COUNT(s.id) AS plays
FROM scrobbles s
JOIN tracks t ON t.id = s.track_id
JOIN artists a ON a.id = t.artist_id
WHERE s.source = 'lastfm'
GROUP BY a.name, t.title
ORDER BY plays DESC
LIMIT 50
"""
st.dataframe(query_df(top_tracks_sql), hide_index=True, use_container_width=True)

# ── Top 50 artists ────────────────────────────────────────────────────────────

st.divider()
st.subheader("Top 50 artists")

top_artists_sql = """
SELECT a.name AS artist, COUNT(s.id) AS plays
FROM scrobbles s
JOIN tracks t ON t.id = s.track_id
JOIN artists a ON a.id = t.artist_id
WHERE s.source = 'lastfm'
GROUP BY a.name
ORDER BY plays DESC
LIMIT 50
"""
st.dataframe(query_df(top_artists_sql), hide_index=True, use_container_width=True)

# ── Sidebar ───────────────────────────────────────────────────────────────────

with st.sidebar:
    if st.button("Refresh data"):
        st.cache_data.clear()
        st.rerun()
