"""Track Lookup tab — search your listening history by track name or artist."""

import pandas as pd
import streamlit as st

from lib.db import get_connection
from lib.artist_popularity import get_scores as get_artist_scores
from lib.track_popularity import get_scores as get_track_scores
from views._badge_display import render_badge_chips
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
    # v0.59 DIAGNOSIS: pre-v0.59 this grouped by track_uri, so each URI variant
    # (e.g. single vs. album release of the same recording) appeared as a separate
    # row with its own per-URI play count.  The 613-play "Total plays" the user saw
    # for Synchronised was an accidental alignment: Spotify had recorded all 613
    # streams under the single (canonical) URI in spotify_plays, so that one URI
    # returned 613 directly.  For tracks that genuinely split plays across two URIs
    # the old query would have undercounted.
    #
    # v0.59 FIX: canonical aggregation — find every canonical group that contains
    # at least one play matching the search term, then sum ALL plays for that
    # canonical (including plays recorded under non-matching URI variants).
    # Returns the canonical URI as track_uri so all downstream detail functions
    # receive a canonical key.
    return _run_query(
        """
        WITH matching_canonicals AS (
            SELECT DISTINCT tm.canonical_track_uri
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE (sp.artist_name ILIKE %s OR sp.track_name ILIKE %s)
              AND sp.track_uri IS NOT NULL
              AND tm.canonical_track_uri IS NOT NULL
        ),
        plays_by_canonical AS (
            SELECT tm.canonical_track_uri AS track_uri,
                   COUNT(*) AS plays
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE tm.canonical_track_uri IN (
                SELECT canonical_track_uri FROM matching_canonicals
            )
            GROUP BY tm.canonical_track_uri
        ),
        canonical_track_names AS (
            -- v0.59.1: track_metadata has no track_name column; source from spotify_plays.
            SELECT DISTINCT ON (track_uri) track_uri, track_name
            FROM spotify_plays
            WHERE track_uri IS NOT NULL
              AND track_name IS NOT NULL
        )
        SELECT ctn.track_name,
               array_to_string(tm_can.artist_names, ', ') AS artist_name,
               pbc.track_uri,
               pbc.plays
        FROM plays_by_canonical pbc
        JOIN track_metadata tm_can ON tm_can.track_uri = pbc.track_uri
        LEFT JOIN canonical_track_names ctn ON ctn.track_uri = pbc.track_uri
        ORDER BY pbc.plays DESC
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
    # v0.59: track_uri is the canonical URI (from _search_tracks).
    # Aggregate ALL plays across every URI that maps to this canonical so that
    # single + album variants are summed (e.g. Synchronised: 469 + 144 = 613).
    return _run_query(
        """
        SELECT
            COUNT(*) AS total_plays,
            MIN(sp.played_at) AS first_played,
            MAX(sp.played_at) AS last_played,
            COUNT(DISTINCT DATE(sp.played_at)) AS days_listened
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        WHERE tm.canonical_track_uri = %s
          AND tm.canonical_track_uri IS NOT NULL
        """,
        (track_uri,),
    )


@st.cache_data(ttl=60)
def _plays_per_month(track_uri: str) -> pd.DataFrame:
    # v0.59: aggregate across all URI variants for this canonical.
    return _run_query(
        """
        SELECT date_trunc('month', sp.played_at) AS month, COUNT(*) AS plays
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        WHERE tm.canonical_track_uri = %s
          AND tm.canonical_track_uri IS NOT NULL
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
    # v0.59: aggregate across all URI variants for this canonical.
    return _run_query(
        """
        SELECT
            sp.reason_end,
            COUNT(*) AS play_count,
            ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS percentage
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        WHERE tm.canonical_track_uri = %s
          AND tm.canonical_track_uri IS NOT NULL
          AND sp.reason_end IS NOT NULL
        GROUP BY sp.reason_end
        ORDER BY play_count DESC
        """,
        (track_uri,),
    )


@st.cache_data(ttl=60)
def _track_uri_variants(canonical_track_uri: str) -> pd.DataFrame:
    """Return one row per track_uri that maps to this canonical group.

    Columns: track_uri, album_type, album_name, release_date, plays_for_uri, is_canonical.
    Single-URI tracks return exactly one row (is_canonical=True) — callers can check
    len(df) > 1 to decide whether to surface the multi-URI badge.

    Note on 'viewed' marker (v0.60): post-v0.59 _search_tracks() always returns the
    canonical URI, so track_uri in the render function IS the canonical URI. There is
    no path by which a user lands on a non-canonical URI detail page; the 'viewed'
    marker (distinct from 'canonical') is therefore unreachable and is omitted from
    this query — the caller only uses is_canonical for the Marker column.
    """
    return _run_query(
        """
        WITH variants AS (
            -- All track_uris that belong to this canonical group
            SELECT tm.track_uri,
                   tm.album_type,
                   tm.release_date
            FROM track_metadata tm
            WHERE tm.canonical_track_uri = %s
              AND tm.track_uri IS NOT NULL
        ),
        album_names AS (
            -- Grab one album_name per variant URI from spotify_plays
            -- (track_metadata has album_id but not album_name)
            SELECT DISTINCT ON (sp.track_uri) sp.track_uri, sp.album_name
            FROM spotify_plays sp
            WHERE sp.track_uri IN (SELECT track_uri FROM variants)
              AND sp.album_name IS NOT NULL
            ORDER BY sp.track_uri
        ),
        per_uri_plays AS (
            -- Plays recorded directly under each raw URI (not consolidated)
            SELECT sp.track_uri, COUNT(*) AS plays_for_uri
            FROM spotify_plays sp
            WHERE sp.track_uri IN (SELECT track_uri FROM variants)
            GROUP BY sp.track_uri
        )
        SELECT v.track_uri,
               v.album_type,
               an.album_name,
               v.release_date,
               COALESCE(pup.plays_for_uri, 0) AS plays_for_uri,
               (v.track_uri = %s)             AS is_canonical
        FROM variants v
        LEFT JOIN album_names  an  ON an.track_uri  = v.track_uri
        LEFT JOIN per_uri_plays pup ON pup.track_uri = v.track_uri
        ORDER BY is_canonical DESC, plays_for_uri DESC
        """,
        (canonical_track_uri, canonical_track_uri),
    )


@st.cache_data(ttl=60)
def _track_heard_alongside(track_uri: str, window_minutes: int = 30) -> pd.DataFrame:
    # v0.60: canonical aggregation.
    # 1. Expand target_plays to ALL URI variants of the focal canonical so that
    #    album-URI plays are included as target timestamps.
    # 2. Group companion tracks by their canonical_track_uri so URI variants of
    #    the same companion merge into one row.
    # 3. Exclude companions whose canonical = the focal canonical (same song).
    # Column shape unchanged: companion_artist, companion_track, companion_uri,
    # co_occurrences — render code requires no changes.
    return _run_query(
        """
        WITH focal_uris AS (
            -- All raw URIs that belong to the focal canonical group
            SELECT track_uri
            FROM track_metadata
            WHERE canonical_track_uri = %s
              AND track_uri IS NOT NULL
        ),
        target_plays AS (
            -- Every play timestamp for any variant of the focal track
            SELECT played_at
            FROM spotify_plays
            WHERE track_uri IN (SELECT track_uri FROM focal_uris)
        ),
        co_by_uri AS (
            -- Raw co-occurrence count per companion track_uri
            SELECT sp.track_uri,
                   COUNT(*) AS co_count
            FROM spotify_plays sp
            JOIN target_plays tp
              ON sp.played_at BETWEEN tp.played_at - (INTERVAL '1 minute' * %s)
                                  AND tp.played_at + (INTERVAL '1 minute' * %s)
            WHERE sp.track_uri IS NOT NULL
            GROUP BY sp.track_uri
        ),
        co_by_canonical AS (
            -- Aggregate co-counts to canonical level; drop focal canonical
            SELECT tm.canonical_track_uri,
                   SUM(cbu.co_count) AS co_occurrences
            FROM co_by_uri cbu
            JOIN track_metadata tm ON tm.track_uri = cbu.track_uri
            WHERE tm.canonical_track_uri IS NOT NULL
              AND tm.canonical_track_uri != %s
            GROUP BY tm.canonical_track_uri
        ),
        canonical_names AS (
            -- One track_name per canonical URI (sourced from spotify_plays)
            SELECT DISTINCT ON (track_uri) track_uri, track_name
            FROM spotify_plays
            WHERE track_uri IN (SELECT canonical_track_uri FROM co_by_canonical)
              AND track_name IS NOT NULL
        )
        SELECT array_to_string(tm_can.artist_names, ', ') AS companion_artist,
               cn.track_name                              AS companion_track,
               cbc.canonical_track_uri                    AS companion_uri,
               cbc.co_occurrences::int                    AS co_occurrences
        FROM co_by_canonical cbc
        JOIN  track_metadata   tm_can ON tm_can.track_uri = cbc.canonical_track_uri
        LEFT JOIN canonical_names cn   ON cn.track_uri    = cbc.canonical_track_uri
        ORDER BY cbc.co_occurrences DESC
        LIMIT 10
        """,
        (track_uri, window_minutes, window_minutes, track_uri),
    )


@st.cache_data(ttl=60)
def _more_from_artist(track_uri: str) -> pd.DataFrame:
    # v0.60: canonical aggregation.
    # 1. Find all canonical groups that share at least one artist with the focal track.
    # 2. Sum plays across ALL URI variants of each canonical (consolidated count).
    # 3. Exclude the focal track's own canonical from results.
    # Column shape unchanged: track_name, track_uri, plays — render code unchanged.
    return _run_query(
        """
        WITH target_artists AS (
            -- Artists on the focal track (track_uri is the canonical URI post-v0.59)
            SELECT artist_names
            FROM track_metadata
            WHERE track_uri = %s
              AND artist_names IS NOT NULL
        ),
        matching_canonicals AS (
            -- Canonical groups that share ≥1 artist with the focal track
            SELECT DISTINCT tm.canonical_track_uri
            FROM track_metadata tm
            CROSS JOIN target_artists ta
            WHERE tm.artist_names IS NOT NULL
              AND tm.artist_names && ta.artist_names
              AND tm.canonical_track_uri IS NOT NULL
              AND tm.canonical_track_uri != %s
        ),
        plays_by_canonical AS (
            -- Consolidated play count across all URI variants per canonical
            SELECT tm.canonical_track_uri,
                   COUNT(*) AS plays
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE tm.canonical_track_uri IN (
                SELECT canonical_track_uri FROM matching_canonicals
            )
            GROUP BY tm.canonical_track_uri
        ),
        canonical_names AS (
            -- One track_name per canonical URI from spotify_plays
            SELECT DISTINCT ON (track_uri) track_uri, track_name
            FROM spotify_plays
            WHERE track_uri IN (SELECT canonical_track_uri FROM plays_by_canonical)
              AND track_name IS NOT NULL
        )
        SELECT cn.track_name,
               pbc.canonical_track_uri AS track_uri,
               pbc.plays
        FROM plays_by_canonical pbc
        LEFT JOIN canonical_names cn ON cn.track_uri = pbc.canonical_track_uri
        ORDER BY pbc.plays DESC
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

    # ── Badge display (v0.70) ─────────────────────────────────────────────────
    # Pokémon-doos of earned vs. available badges, aggregated across all URI variants
    # under this canonical. Non-fatal (matches v0.60/v0.61) — a badge-render failure
    # must never take down the rest of the detail view.
    # track_uri here is the canonical URI (post-v0.59 search flow).
    try:
        render_badge_chips(get_connection(), track_uri)
    except Exception as e:
        st.warning(f"Badge display failed: {e}")

    # ── URI variant visibility (v0.60) ────────────────────────────────────────
    # Only shown when canonical group contains >1 URI (single-URI tracks are silent).
    # track_uri here is always the canonical URI (post-v0.59 search flow), so
    # _track_uri_variants keying on it is correct.
    variants_df = _track_uri_variants(track_uri)
    if len(variants_df) > 1:
        st.info(f"This track combines {len(variants_df)} URI variants")
        with st.expander("Variant breakdown", expanded=False):
            disp_variants = variants_df.copy()
            # "viewed" marker: unreachable in current flow — search always returns the
            # canonical URI, so the user can never navigate to a non-canonical detail
            # page. Only "canonical" and "" are used.
            disp_variants["Marker"] = disp_variants["is_canonical"].map(
                lambda c: "canonical" if c else ""
            )
            disp_variants = disp_variants.rename(columns={
                "track_uri":     "URI",
                "album_type":    "Album type",
                "album_name":    "Album name",
                "release_date":  "Release date",
                "plays_for_uri": "Plays for this URI",
            })
            st.dataframe(
                disp_variants[["URI", "Album type", "Album name", "Release date",
                                "Plays for this URI", "Marker"]],
                hide_index=True,
            )

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
