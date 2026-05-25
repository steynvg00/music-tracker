"""Album Lookup section — search listening history by album name."""

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
def _search_albums(query: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            album_name,
            string_agg(DISTINCT artist_name, ', ' ORDER BY artist_name) AS artists_aggregated,
            COUNT(DISTINCT track_uri) AS unique_tracks,
            COUNT(*) AS total_plays
        FROM spotify_plays
        WHERE album_name ILIKE %s
          AND album_name IS NOT NULL
          AND artist_name IS NOT NULL
          AND track_uri IS NOT NULL
        GROUP BY album_name
        ORDER BY total_plays DESC
        LIMIT 20
        """,
        (f"%{query}%",),
    )


@st.cache_data(ttl=60)
def _album_summary(album_name: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            COUNT(*) AS total_plays,
            COUNT(DISTINCT track_uri) AS unique_tracks,
            MIN(played_at) AS first_listen,
            MAX(played_at) AS last_listen,
            ROUND(SUM(ms_played) / 3600000.0, 2) AS total_listening_hours
        FROM spotify_plays
        WHERE album_name = %s
          AND artist_name IS NOT NULL
          AND track_uri IS NOT NULL
        """,
        (album_name,),
    )


@st.cache_data(ttl=60)
def _album_plays_per_month(album_name: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            DATE_TRUNC('month', played_at) AS month,
            COUNT(*) AS plays
        FROM spotify_plays
        WHERE album_name = %s
          AND album_name IS NOT NULL
        GROUP BY month
        ORDER BY month ASC
        """,
        (album_name,),
    )


@st.cache_data(ttl=60)
def _album_tracks(album_name: str) -> pd.DataFrame:
    # v0.59 — canonical aggregation (introduced v0.57/v0.58).
    # Strategy: find every canonical group that contains ANY track URI appearing
    # on this album, then aggregate ALL plays for those canonicals — including plays
    # recorded under URI variants that don't show album_name = this album.
    #
    # Example: Synchronised appears on the "Synchronised" album with its album-track
    # URI (144 plays) but also exists as a single URI (469 plays).  The single URI's
    # plays don't carry album_name = "Synchronised", so the old per-URI query showed
    # only 144 plays.  This query follows the canonical link and counts 613 total.
    #
    # Column names (track_name, artists, track_uri, play_count, completion_rate) are
    # preserved for downstream Python compatibility.
    return _run_query(
        """
        WITH album_track_uris AS (
            -- All distinct URIs that Spotify recorded under this album name
            SELECT DISTINCT track_uri
            FROM spotify_plays
            WHERE album_name = %s
              AND track_uri IS NOT NULL
        ),
        canonical_groups AS (
            -- Deduplicate to one canonical_track_uri per recording
            SELECT DISTINCT tm.canonical_track_uri
            FROM album_track_uris atu
            JOIN track_metadata tm ON tm.track_uri = atu.track_uri
            WHERE tm.canonical_track_uri IS NOT NULL
        ),
        all_plays_for_canonicals AS (
            -- Sum plays from ALL URI variants (album + single + any other release)
            SELECT tm.canonical_track_uri,
                   COUNT(*) AS play_count,
                   SUM(CASE WHEN sp.reason_end = 'trackdone' THEN 1 ELSE 0 END) AS completed_plays
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE tm.canonical_track_uri IN (SELECT canonical_track_uri FROM canonical_groups)
            GROUP BY tm.canonical_track_uri
        )
        SELECT tm_can.track_name,
               array_to_string(tm_can.artist_names, ', ') AS artists,
               apc.canonical_track_uri AS track_uri,
               apc.play_count,
               ROUND(apc.completed_plays * 100.0 / NULLIF(apc.play_count, 0), 1) AS completion_rate
        FROM all_plays_for_canonicals apc
        JOIN track_metadata tm_can ON tm_can.track_uri = apc.canonical_track_uri
        ORDER BY apc.play_count DESC
        LIMIT 50
        """,
        (album_name,),
    )


@st.cache_data(ttl=60)
def _album_artist_credits(album_name: str) -> pd.DataFrame:
    return _run_query(
        """
        SELECT
            artist_name,
            COUNT(*) AS play_count
        FROM spotify_plays
        WHERE album_name = %s
          AND artist_name IS NOT NULL
        GROUP BY artist_name
        ORDER BY play_count DESC
        """,
        (album_name,),
    )


def render_album_lookup_section() -> None:
    """Render the Album lookup section content."""
    query = st.text_input("Search by album name", key="album_lookup_query")

    if not query:
        st.caption("Start typing to search your listening history")
        return

    ph_search = st.empty()
    with ph_search.container():
        skeleton_table(20)
    results_df = _search_albums(query)
    ph_search.empty()

    if results_df.empty:
        st.info("No albums found matching your search.")
        return

    def _fmt(idx: int) -> str:
        row = results_df.iloc[idx]
        return (
            f"{row['album_name']} — {row['artists_aggregated']} "
            f"({int(row['total_plays'])} plays, {int(row['unique_tracks'])} tracks)"
        )

    selected_idx = st.selectbox(
        "Select an album",
        range(len(results_df)),
        format_func=_fmt,
        key="album_lookup_select",
    )

    selected = results_df.iloc[selected_idx]
    album_name = selected["album_name"]
    artists_aggregated = selected["artists_aggregated"]

    st.divider()

    # ── Album header ──────────────────────────────────────────────────────────
    st.header(album_name)
    st.caption(f"by {artists_aggregated}")

    # ── Metrics row ───────────────────────────────────────────────────────────
    ph_metrics = st.empty()
    with ph_metrics.container():
        skeleton_metric_row(4)
    summary_df = _album_summary(album_name)
    ph_metrics.empty()

    if not summary_df.empty:
        m = summary_df.iloc[0]
        mc1, mc2, mc3, mc4 = st.columns(4)
        mc1.metric("Total plays", f"{int(m['total_plays']):,}")
        mc2.metric("Unique tracks", f"{int(m['unique_tracks']):,}")
        mc3.metric(
            "First listen",
            pd.to_datetime(m["first_listen"]).strftime("%Y-%m-%d") if m["first_listen"] is not None else "—",
        )
        mc4.metric(
            "Last listen",
            pd.to_datetime(m["last_listen"]).strftime("%Y-%m-%d") if m["last_listen"] is not None else "—",
        )

    st.divider()

    # ── Plays per month ───────────────────────────────────────────────────────
    st.subheader("Plays per month")
    ph_chart = st.empty()
    with ph_chart.container():
        skeleton_chart()
    ppm_df = _album_plays_per_month(album_name)
    ph_chart.empty()

    if not ppm_df.empty:
        ppm_df["month"] = pd.to_datetime(ppm_df["month"])
        st.line_chart(ppm_df.set_index("month")["plays"])
    else:
        st.info("No monthly play data available.")

    st.divider()

    # ── Tracks in album ───────────────────────────────────────────────────────
    st.subheader("Tracks in album")
    ph_tracks = st.empty()
    with ph_tracks.container():
        skeleton_table(10)
    tracks_df = _album_tracks(album_name)
    ph_tracks.empty()

    if not tracks_df.empty:
        disp_tracks = tracks_df.rename(columns={
            "track_name": "Track",
            "artists": "Artists",
            "play_count": "Plays",
            "completion_rate": "Completion %",
        })
        disp_tracks.insert(0, "Rank", range(1, len(disp_tracks) + 1))
        st.dataframe(
            disp_tracks[["Rank", "Track", "Artists", "Plays", "Completion %"]],
            hide_index=True,
            width="stretch",
        )
    else:
        st.info("No track data found for this album.")

    st.divider()

    # ── Artist credits breakdown ──────────────────────────────────────────────
    with st.expander("Artist credits breakdown"):
        st.caption(
            "Raw artist credit strings recorded for this album. "
            "Multi-artist tracks appear under each credited variant "
            "(e.g. 'D-Sturb', 'Warface', 'D-Sturb, Warface'). "
            "This is a known data limitation — multi-artist attribution "
            "reconciliation is tracked separately."
        )
        ph_credits = st.empty()
        with ph_credits.container():
            skeleton_table(5)
        credits_df = _album_artist_credits(album_name)
        ph_credits.empty()

        if not credits_df.empty:
            disp_credits = credits_df.rename(columns={
                "artist_name": "Artist credit",
                "play_count": "Plays",
            })
            st.dataframe(disp_credits, hide_index=True)
        else:
            st.info("No artist credit data found.")
