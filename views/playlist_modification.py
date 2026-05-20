"""Playlist Modification page — Make a playlist + Manage custom playlists."""

import os

import pandas as pd
import psycopg
import streamlit as st
from datetime import datetime, timedelta, timezone

from lib.db import get_connection
from lib.spotify import get_spotify_client
from lib.temporary_playlists import (
    list_artists,
    query_temp_playlist_tracks,
    create_temp_playlist,
    build_filters_summary,
    delete_custom_playlist,
)

tab_make_a_playlist, tab_manage = st.tabs(["Make a playlist", "Manage custom playlists"])

# ── Tab 1: Make a playlist ────────────────────────────────────────────────────

with tab_make_a_playlist:
    st.header("Make a playlist")
    st.caption(
        "Create a custom one-off playlist on Spotify from your listening history. "
        "Pick filters, preview the tracks, then create. The playlist is yours to keep "
        "or delete — it won't refresh automatically."
    )

    conn = get_connection()

    @st.cache_data(ttl=300)
    def _load_artists():
        return list_artists(conn, limit=2000)

    all_artists = _load_artists()
    artist_names = [a[0] for a in all_artists]

    st.subheader("Filters")
    col1, col2 = st.columns(2)

    with col1:
        selected_artists = st.multiselect(
            "Artists (any of)",
            options=artist_names,
            default=[],
            help="Match if any selected artist appears in the track's artist credit (handles collabs).",
        )

        release_year_range = st.slider(
            "Release year range",
            min_value=1980,
            max_value=2026,
            value=(1980, 2026),
            help="Track's original release year (from track_metadata).",
        )

        discovery_year_range = st.slider(
            "Discovery year range",
            min_value=2017,
            max_value=2026,
            value=(2017, 2026),
            help="Year you first played the track.",
        )

    with col2:
        min_plays = st.number_input(
            "Minimum play count",
            min_value=1,
            max_value=10000,
            value=1,
            step=1,
        )

        max_tracks = st.number_input(
            "Maximum tracks",
            min_value=1,
            max_value=10000,
            value=100,
            step=10,
        )

        liked_only = st.checkbox(
            "Liked songs only",
            value=False,
        )

        sort_order = st.selectbox(
            "Sort order",
            options=[
                ("plays_desc", "Most played first"),
                ("plays_asc", "Least played first"),
                ("first_play_asc", "First discovered first"),
                ("first_play_desc", "Most recently discovered first"),
                ("release_asc", "Oldest release first"),
                ("release_desc", "Newest release first"),
                ("random", "Random"),
            ],
            format_func=lambda x: x[1],
        )[0]

    release_year_min = release_year_range[0] if release_year_range[0] > 1980 else None
    release_year_max = release_year_range[1] if release_year_range[1] < 2026 else None
    discovery_year_min = discovery_year_range[0] if discovery_year_range[0] > 2017 else None
    discovery_year_max = discovery_year_range[1] if discovery_year_range[1] < 2026 else None

    st.divider()

    if st.button("Preview matching tracks", type="primary"):
        with st.spinner("Querying..."):
            tracks = query_temp_playlist_tracks(
                conn,
                artists=selected_artists if selected_artists else None,
                release_year_min=release_year_min,
                release_year_max=release_year_max,
                discovery_year_min=discovery_year_min,
                discovery_year_max=discovery_year_max,
                min_plays=min_plays if min_plays > 1 else None,
                max_tracks=int(max_tracks),
                liked_only=liked_only,
                sort_order=sort_order,
            )
        st.session_state["temp_playlist_tracks"] = tracks
        st.session_state["temp_playlist_filters"] = {
            "artists": selected_artists,
            "release_year_min": release_year_min,
            "release_year_max": release_year_max,
            "discovery_year_min": discovery_year_min,
            "discovery_year_max": discovery_year_max,
            "min_plays": min_plays if min_plays > 1 else None,
            "liked_only": liked_only,
            "sort_order": sort_order,
        }

    if "temp_playlist_tracks" in st.session_state:
        tracks = st.session_state["temp_playlist_tracks"]
        st.markdown(f"**{len(tracks)} tracks matching your filters**")

        if tracks:
            df = pd.DataFrame(tracks)
            df_display = df[["track_name", "artist_name", "album_name", "plays", "release_year"]].copy()
            df_display.columns = ["Track", "Artist", "Album", "Plays", "Released"]
            st.dataframe(df_display, width="stretch", height=400)

            st.divider()
            st.subheader("Create on Spotify")
            playlist_name = st.text_input(
                "Playlist name (will get ' · Custom 🎧' appended)",
                value="",
                placeholder="e.g. 'Late night hardstyle' or 'Best of summer 2022'",
            )

            ttl_days = st.number_input(
                "Auto-delete after (days)",
                min_value=0,
                max_value=365,
                value=7,
                step=1,
                help="The playlist will be automatically deleted from Spotify after this many days. "
                     "Set to 0 to make permanent (you can also change this in v0.32's Manage custom playlists view).",
            )

            if st.button("Create on Spotify", type="primary", disabled=not playlist_name.strip()):
                with st.spinner("Creating playlist..."):
                    sp = get_spotify_client()
                    user_id = sp.current_user()["id"]
                    filters = st.session_state["temp_playlist_filters"]
                    summary = build_filters_summary(
                        filters["artists"],
                        filters["release_year_min"],
                        filters["release_year_max"],
                        filters["discovery_year_min"],
                        filters["discovery_year_max"],
                        filters["min_plays"],
                        filters["liked_only"],
                        filters["sort_order"],
                    )

                    expires_at = None
                    if ttl_days > 0:
                        expires_at = datetime.now(timezone.utc) + timedelta(days=int(ttl_days))

                    write_conn = psycopg.connect(os.environ["DATABASE_URL"])
                    try:
                        result = create_temp_playlist(
                            sp,
                            user_id,
                            playlist_name.strip(),
                            [t["track_uri"] for t in tracks],
                            summary,
                            conn=write_conn,
                            expires_at=expires_at,
                        )
                    finally:
                        write_conn.close()

                if expires_at:
                    expiry_local = expires_at.strftime("%Y-%m-%d %H:%M UTC")
                    st.success(
                        f"Created **{result['name']}** with {result['track_count']} tracks. "
                        f"Auto-deletes on **{expiry_local}**. "
                        f"[Open on Spotify]({result['url']})"
                    )
                else:
                    st.success(
                        f"Created **{result['name']}** with {result['track_count']} tracks. "
                        f"**Permanent** — delete manually when done. "
                        f"[Open on Spotify]({result['url']})"
                    )

                del st.session_state["temp_playlist_tracks"]
                del st.session_state["temp_playlist_filters"]
        else:
            st.info("No tracks match these filters. Try widening the criteria.")

# ── Tab 2: Manage custom playlists ────────────────────────────────────────────

with tab_manage:
    st.header("Manage custom playlists")

    read_conn = get_connection()
    cur = read_conn.cursor()
    cur.execute("""
        SELECT playlist_id, name, created_at, expires_at, track_count, filters_summary
        FROM custom_playlists
        ORDER BY created_at DESC
    """)
    rows = cur.fetchall()
    cur.close()

    if not rows:
        st.info("No custom playlists yet. Head to the Make a playlist tab to create one.")
    else:
        for playlist_id, name, created_at, expires_at, track_count, filters_summary in rows:
            with st.container(border=True):
                info_col, action_col = st.columns([3, 2])

                with info_col:
                    st.markdown(f"**{name}**")
                    created_str = created_at.strftime("%Y-%m-%d") if created_at else "—"
                    st.caption(f"Created: {created_str} · {track_count} tracks")
                    if expires_at:
                        expiry_str = expires_at.strftime("%Y-%m-%d %H:%M UTC")
                        st.caption(f"Expires: {expiry_str}")
                    else:
                        st.caption("Permanent")

                with action_col:
                    key_suffix = playlist_id.replace("-", "_")

                    if expires_at is not None:
                        if st.button("Make permanent", key=f"perm_{key_suffix}"):
                            write_conn = psycopg.connect(os.environ["DATABASE_URL"])
                            try:
                                write_cur = write_conn.cursor()
                                write_cur.execute(
                                    "UPDATE custom_playlists SET expires_at = NULL WHERE playlist_id = %s",
                                    (playlist_id,),
                                )
                                write_conn.commit()
                            finally:
                                write_conn.close()
                            st.rerun()

                        if st.button("Extend +7 days", key=f"extend_{key_suffix}"):
                            write_conn = psycopg.connect(os.environ["DATABASE_URL"])
                            try:
                                write_cur = write_conn.cursor()
                                write_cur.execute(
                                    "UPDATE custom_playlists SET expires_at = COALESCE(expires_at, NOW()) + INTERVAL '7 days' WHERE playlist_id = %s",
                                    (playlist_id,),
                                )
                                write_conn.commit()
                            finally:
                                write_conn.close()
                            st.rerun()

                    confirm_key = f"confirm_delete_{key_suffix}"
                    if st.session_state.get(confirm_key):
                        if st.button("Click again to confirm", key=f"del_confirm_{key_suffix}", type="primary"):
                            sp = get_spotify_client()
                            write_conn = psycopg.connect(os.environ["DATABASE_URL"])
                            try:
                                delete_custom_playlist(sp, write_conn, playlist_id)
                            finally:
                                write_conn.close()
                            del st.session_state[confirm_key]
                            st.rerun()
                    else:
                        if st.button("Delete now", key=f"del_{key_suffix}"):
                            st.session_state[confirm_key] = True
                            st.rerun()
