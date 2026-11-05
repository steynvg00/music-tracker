"""Playlist Modification page — read-only since v0.83 (R3): writes moved to Rotor.

Preview still works here; creating, extending, deleting, rebuilding and re-ordering playlists
happen in the Rotor hub (links on each row). Same tables, so both stay consistent.
"""

import pandas as pd
import streamlit as st

from lib.db import get_connection
from lib.playlists import (
    get_snapshot_definitions,
    get_updating_definitions,
    get_full_name,
    SNAPSHOT_NAME_SUFFIX,
    UPDATING_NAME_SUFFIX,
)
from lib.playlist_settings import (
    ORDER_PREF_OPTIONS,
    get_all_settings_by_name,
)
from lib.temporary_playlists import (
    list_artists,
    query_temp_playlist_tracks,
)
from views._rotor_banner import rotor_banner, rotor_url

rotor_banner("Custom playlists, snapshot rebuilds and sort orders", "/library")

tab_make_a_playlist, tab_manage, tab_snapshot, tab_updating = st.tabs([
    "Make a playlist", "Manage custom playlists", "Manage snapshot", "Manage updating",
])

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
            st.markdown(
                f"**Create it in Rotor:** [Library › New custom playlist]({rotor_url('/library')}) "
                "uses the same filters (and the same SQL), then lets you name it and pick a lifetime."
            )
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
                    st.markdown(f"[Extend, keep, edit or delete in Rotor]({rotor_url('/playlist/' + playlist_id)})")

# ── Shared helpers for Manage snapshot / Manage updating ─────────────────────

_CRON_CAPTION = (
    "Read-only here. Rebuild a snapshot or change a sort order on the playlist's page in Rotor "
    "(Refresh now applies it right away)."
)


def _rotor_link(full_name: str, settings_by_name: dict) -> str:
    """Rotor page for a managed playlist (id from playlist_settings; Library when unknown). No Spotify calls."""
    row = settings_by_name.get(full_name)
    if row and row.get("playlist_id"):
        return rotor_url(f"/playlist/{row['playlist_id']}")
    return rotor_url("/library")


def _categorize_snapshot(suffix: str) -> str:
    if suffix.startswith("Top 25"):
        return "Monthly Top 25"
    if suffix.startswith("Top 50"):
        return "Seasonal Top 50"
    if "All-Time" in suffix:
        return "All-Time Top 100"
    if suffix.startswith("Top 100"):
        return "Yearly Top 100"
    return "Other"


def _categorize_updating(suffix: str) -> str:
    if suffix.endswith("plays"):
        return "Threshold tiers"
    if suffix.startswith("Top "):
        return "Top N"
    if "Discovered" in suffix:
        return "Year Discovered"
    if "Released" in suffix:
        return "Year Released"
    if suffix.startswith("My "):
        return "Monthly #1"
    return "Misc"


# ── Tab 3: Manage snapshot ────────────────────────────────────────────────────

with tab_snapshot:
    st.header("Manage snapshot playlists")
    st.caption(_CRON_CAPTION)

    snap_conn = get_connection()
    snap_defs = get_snapshot_definitions(snap_conn)
    snap_settings = get_all_settings_by_name(snap_conn)

    # Group definitions by snapshot category
    snap_groups: dict[str, list] = {}
    for defn in snap_defs:
        cat = _categorize_snapshot(defn.suffix)
        snap_groups.setdefault(cat, []).append(defn)

    group_order = ["Monthly Top 25", "Seasonal Top 50", "Yearly Top 100", "All-Time Top 100", "Other"]
    for group_name in group_order:
        group_defs = snap_groups.get(group_name)
        if not group_defs:
            continue
        with st.expander(f"{group_name} ({len(group_defs)})", expanded=False):
            for defn in group_defs:
                full_name = get_full_name(defn)
                row_settings = snap_settings.get(full_name)
                force_at = row_settings.get("force_refresh_requested_at") if row_settings else None
                done_at = row_settings.get("force_refresh_completed_at") if row_settings else None
                force_pending = force_at is not None and (done_at is None or force_at > done_at)

                col_name, col_status, col_btn = st.columns([4, 3, 2])
                with col_name:
                    st.markdown(f"**{defn.suffix}**")
                with col_status:
                    if force_pending:
                        st.caption(f"⏳ Pending — {force_at.strftime('%Y-%m-%d %H:%M') if force_at else ''}")
                    elif done_at:
                        st.caption(f"✅ Last refreshed: {done_at.strftime('%Y-%m-%d %H:%M')}")
                    else:
                        st.caption("Never force-refreshed")
                with col_btn:
                    st.markdown(f"[Rebuild in Rotor]({_rotor_link(full_name, snap_settings)})")

# ── Tab 4: Manage updating ────────────────────────────────────────────────────

with tab_updating:
    st.header("Manage updating playlists")
    st.caption(_CRON_CAPTION)

    upd_conn = get_connection()
    upd_defs = get_updating_definitions(upd_conn)
    upd_settings = get_all_settings_by_name(upd_conn)

    # Group definitions by category
    upd_groups: dict[str, list] = {}
    for defn in upd_defs:
        cat = _categorize_updating(defn.suffix)
        upd_groups.setdefault(cat, []).append(defn)

    group_order_upd = ["Threshold tiers", "Top N", "Year Discovered", "Year Released", "Monthly #1", "Misc"]
    for group_name in group_order_upd:
        group_defs = upd_groups.get(group_name)
        if not group_defs:
            continue
        with st.expander(f"{group_name} ({len(group_defs)})", expanded=False):
            for defn in group_defs:
                full_name = get_full_name(defn)
                row_settings = upd_settings.get(full_name)
                current_pref = row_settings.get("order_pref", "default") if row_settings else "default"
                current_label = ORDER_PREF_OPTIONS.get(current_pref, ORDER_PREF_OPTIONS["default"])

                col_name, col_select = st.columns([4, 4])
                with col_name:
                    st.markdown(f"**{defn.suffix}**")
                with col_select:
                    st.markdown(f"{current_label} · [change in Rotor]({_rotor_link(full_name, upd_settings)})")
