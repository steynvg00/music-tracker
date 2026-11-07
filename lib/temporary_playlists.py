"""Generate one-off custom playlists from filter criteria.

Custom playlists are user-named, user-managed (no auto-refresh, no auto-delete).
Naming format: '{user_name} · Custom 🎧'.
"""

import json
import sys

import psycopg
from datetime import datetime, timedelta, timezone
from typing import Literal

from lib.email_notify import EmailEventCollector, EventType, PlaylistEvent, send_digest

CUSTOM_NAME_SUFFIX = " · Custom 🎧"


SORT_ORDERS = (
    "random",
    "plays_desc",
    "plays_asc",
    "first_play_asc",
    "first_play_desc",
    "release_asc",
    "release_desc",
)


def preview_filters(
    artists: list[str] | None = None,
    release_year_min: int | None = None,
    release_year_max: int | None = None,
    discovery_year_min: int | None = None,
    discovery_year_max: int | None = None,
    min_plays: int | None = None,
    max_tracks: int = 100,
    liked_only: bool = False,
    sort_order: str = "plays_desc",
) -> dict:
    """The filters dict for hub.custom_playlist_preview() (migration 0022).

    Same keys the Rotor hub stores in custom_playlists.filters_json. Streamlit doesn't
    store them (its rows keep filters_json NULL), so only Rotor-made playlists can be
    edited with their original filters in Rotor.
    """
    return {
        "artists": list(artists or []),
        "release_year_min": release_year_min,
        "release_year_max": release_year_max,
        "discovery_year_min": discovery_year_min,
        "discovery_year_max": discovery_year_max,
        "min_plays": min_plays,
        "max_tracks": min(max_tracks, 10000),
        "liked_only": bool(liked_only),
        "sort_order": sort_order if sort_order in SORT_ORDERS else "plays_desc",
    }


def _rows_to_dicts(rows) -> list[dict]:
    return [
        {
            "track_uri": row[0],
            "track_name": row[1],
            "artist_name": row[2],
            "album_name": row[3],
            "plays": row[4],
            "first_played_at": row[5],
            "release_year": row[6],
            "release_date": row[7],
        }
        for row in rows
    ]


def query_temp_playlist_tracks(
    conn,
    artists: list[str] | None = None,
    release_year_min: int | None = None,
    release_year_max: int | None = None,
    discovery_year_min: int | None = None,
    discovery_year_max: int | None = None,
    min_plays: int | None = None,
    max_tracks: int = 100,
    liked_only: bool = False,
    sort_order: Literal[
        "random",
        "plays_desc",
        "plays_asc",
        "first_play_asc",
        "first_play_desc",
        "release_asc",
        "release_desc",
    ] = "plays_desc",
) -> list[dict]:
    """Return list of track dicts matching the filter criteria.

    Each dict has keys: track_uri, track_name, artist_name, album_name, plays,
    first_played_at, release_year, release_date.

    v0.82: runs the shared SQL function hub.custom_playlist_preview(filters) that the
    Rotor hub also uses, so both apps select the same tracks. Until migration 0022 is
    applied the function doesn't exist; then the original inline query runs instead.
    """
    filters = preview_filters(
        artists, release_year_min, release_year_max, discovery_year_min, discovery_year_max,
        min_plays, max_tracks, liked_only, sort_order,
    )
    cur = conn.cursor()
    try:
        cur.execute("SELECT * FROM hub.custom_playlist_preview(%s::jsonb)", (json.dumps(filters),))
        return _rows_to_dicts(cur.fetchall())
    except (psycopg.errors.UndefinedFunction, psycopg.errors.InvalidSchemaName):
        conn.rollback()
        return _query_temp_playlist_tracks_inline(
            conn, artists, release_year_min, release_year_max, discovery_year_min,
            discovery_year_max, min_plays, max_tracks, liked_only, sort_order,
        )


def _query_temp_playlist_tracks_inline(
    conn,
    artists: list[str] | None = None,
    release_year_min: int | None = None,
    release_year_max: int | None = None,
    discovery_year_min: int | None = None,
    discovery_year_max: int | None = None,
    min_plays: int | None = None,
    max_tracks: int = 100,
    liked_only: bool = False,
    sort_order: Literal[
        "random",
        "plays_desc",
        "plays_asc",
        "first_play_asc",
        "first_play_desc",
        "release_asc",
        "release_desc",
    ] = "plays_desc",
) -> list[dict]:
    """Pre-v0.82 inline query; the fallback until migration 0022 is applied.

    All filters are optional and AND-composed. Empty `artists` list means no artist filter.
    """
    cur = conn.cursor()

    if min_plays is not None:
        having_min_plays = "HAVING COUNT(*) >= %s"
        params: list = [min_plays]
    else:
        having_min_plays = ""
        params = []

    artist_filter = ""
    if artists:
        artist_filter = "AND (" + " OR ".join(["sp.artist_name ILIKE %s"] * len(artists)) + ")"
        params = [f"%{a}%" for a in artists] + params  # artist params come BEFORE min_plays param in HAVING

    sql_parts = [
        "WITH per_track AS (",
        "  SELECT",
        "    sp.track_uri,",
        "    MAX(sp.track_name) AS track_name,",
        "    MAX(sp.artist_name) AS artist_name,",
        "    MAX(sp.album_name) AS album_name,",
        "    COUNT(*) AS plays,",
        "    MIN(sp.played_at) AS first_played_at",
        "  FROM spotify_plays sp",
        "  WHERE sp.track_uri IS NOT NULL",
    ]
    if artist_filter:
        sql_parts.append(f"    {artist_filter}")
    sql_parts.extend([
        "  GROUP BY sp.track_uri",
    ])
    if having_min_plays:
        sql_parts.append(f"  {having_min_plays}")
    sql_parts.append(")")

    sql_parts.extend([
        "SELECT",
        "  pt.track_uri,",
        "  pt.track_name,",
        "  pt.artist_name,",
        "  pt.album_name,",
        "  pt.plays,",
        "  pt.first_played_at,",
        "  tm.release_year,",
        "  tm.release_date",
        "FROM per_track pt",
        "LEFT JOIN track_metadata tm ON tm.track_uri = pt.track_uri",
    ])
    if liked_only:
        sql_parts.append("INNER JOIN liked_songs ls ON ls.track_uri = pt.track_uri")

    outer_where = ["1=1"]
    if release_year_min is not None:
        outer_where.append("tm.release_year >= %s")
        params.append(release_year_min)
    if release_year_max is not None:
        outer_where.append("tm.release_year <= %s")
        params.append(release_year_max)
    if discovery_year_min is not None:
        outer_where.append(
            "EXTRACT(YEAR FROM pt.first_played_at AT TIME ZONE 'Europe/Amsterdam')::int >= %s"
        )
        params.append(discovery_year_min)
    if discovery_year_max is not None:
        outer_where.append(
            "EXTRACT(YEAR FROM pt.first_played_at AT TIME ZONE 'Europe/Amsterdam')::int <= %s"
        )
        params.append(discovery_year_max)

    if len(outer_where) > 1:
        sql_parts.append("WHERE " + " AND ".join(outer_where))

    sort_clauses = {
        "random": "ORDER BY RANDOM()",
        "plays_desc": "ORDER BY pt.plays DESC, pt.first_played_at ASC",
        "plays_asc": "ORDER BY pt.plays ASC, pt.first_played_at ASC",
        "first_play_asc": "ORDER BY pt.first_played_at ASC",
        "first_play_desc": "ORDER BY pt.first_played_at DESC",
        "release_asc": "ORDER BY tm.release_date ASC NULLS LAST, pt.plays DESC",
        "release_desc": "ORDER BY tm.release_date DESC NULLS LAST, pt.plays DESC",
    }
    sql_parts.append(sort_clauses.get(sort_order, sort_clauses["plays_desc"]))

    sql_parts.append("LIMIT %s")
    params.append(min(max_tracks, 10000))

    sql = "\n".join(sql_parts)
    cur.execute(sql, params)
    return _rows_to_dicts(cur.fetchall())


def build_filters_summary(
    artists: list[str] | None,
    release_year_min: int | None,
    release_year_max: int | None,
    discovery_year_min: int | None,
    discovery_year_max: int | None,
    min_plays: int | None,
    liked_only: bool,
    sort_order: str,
) -> str:
    """Build a human-readable summary of the filters for the playlist description."""
    parts = []
    if artists:
        parts.append(f"artists={', '.join(artists[:3])}{'+' if len(artists) > 3 else ''}")
    if release_year_min is not None or release_year_max is not None:
        parts.append(f"release={release_year_min or '*'}-{release_year_max or '*'}")
    if discovery_year_min is not None or discovery_year_max is not None:
        parts.append(f"discovered={discovery_year_min or '*'}-{discovery_year_max or '*'}")
    if min_plays is not None:
        parts.append(f"plays>={min_plays}")
    if liked_only:
        parts.append("liked only")
    parts.append(f"sort={sort_order}")
    return "; ".join(parts) if parts else "none"


def create_temp_playlist(
    sp,
    user_id: str,
    name: str,
    track_uris: list[str],
    filters_summary: str,
    conn=None,
    expires_at: datetime | None = None,
) -> dict:
    """Create a new playlist on Spotify with the given tracks. If `conn` is provided,
    also write a row to custom_playlists tracking the playlist for the sweep job.

    expires_at: UTC timestamp when this playlist should be auto-deleted. None means permanent.
    """
    full_name = f"{name}{CUSTOM_NAME_SUFFIX}"

    if expires_at:
        expiry_str = expires_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        description = (
            f"Custom playlist generated by music-tracker. Filters: {filters_summary}. "
            f"Auto-delete on {expiry_str} — make permanent in the dashboard to keep it."
        )
    else:
        description = (
            f"Custom playlist generated by music-tracker. Filters: {filters_summary}. "
            f"Permanent — delete manually when done."
        )

    playlist = sp.user_playlist_create(
        user_id, full_name, public=True, description=description
    )
    playlist_id = playlist["id"]

    for i in range(0, len(track_uris), 100):
        batch = track_uris[i:i + 100]
        sp.playlist_add_items(playlist_id, batch)

    if conn is not None:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO custom_playlists (playlist_id, name, expires_at, track_count, filters_summary)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (playlist_id, full_name, expires_at, len(track_uris), filters_summary),
        )
        conn.commit()

    return {
        "playlist_id": playlist_id,
        "name": full_name,
        "track_count": len(track_uris),
        "url": playlist["external_urls"]["spotify"],
        "expires_at": expires_at,
    }


def delete_custom_playlist(sp, conn, playlist_id: str) -> bool:
    """Unfollow a custom playlist on Spotify and remove its row from custom_playlists.

    Commits conn after the DB delete. Returns True if Spotify deletion succeeded.
    Always removes the DB row so the sweep does not retry forever.
    """
    spotify_ok = True
    try:
        # Spotify "delete" = unfollow your own playlist, removing it from your library
        sp.current_user_unfollow_playlist(playlist_id)
    except Exception:
        spotify_ok = False
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM custom_playlists WHERE playlist_id = %s",
        (playlist_id,),
    )
    conn.commit()
    return spotify_ok


def delete_expired_custom_playlists(sp, conn) -> dict:
    """Find and delete expired custom playlists from both Spotify and the DB.

    Returns a dict with summary stats: {'expired': int, 'deleted_spotify': int,
    'deleted_db': int, 'failed': int}.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT playlist_id, name, expires_at, track_count
        FROM custom_playlists
        WHERE expires_at IS NOT NULL
          AND expires_at < NOW()
        ORDER BY expires_at ASC
        """
    )
    expired = cur.fetchall()
    print(f"[sweep] Found {len(expired)} expired custom playlists.", flush=True)

    deleted_spotify = 0
    deleted_db = 0
    failed = 0
    collector = EmailEventCollector()

    for playlist_id, name, expires_at, track_count in expired:
        print(f"[sweep] Deleting '{name}' (expired {expires_at})...", flush=True)
        ok = delete_custom_playlist(sp, conn, playlist_id)
        if ok:
            deleted_spotify += 1
        else:
            print(f"[sweep]   FAILED to delete on Spotify", flush=True)
            failed += 1
        deleted_db += 1
        extra = {"expires_at": expires_at.isoformat() if expires_at is not None else ""}
        if track_count is not None:
            extra["track_count"] = track_count
        collector.add_event(PlaylistEvent(
            event_type=EventType.CUSTOM_DELETED,
            playlist_name=name,
            playlist_kind="custom",
            is_top_playlist=False,
            tracks=[],
            extra=extra,
        ))

    # Best-effort push (v0.89): deletions already committed to Spotify + DB above, so a
    # notification problem must not change the sweep's exit code.
    try:
        sent = send_digest(collector, conn, run_type="sweep")
        if sent:
            print(f"Pushed sweep digest with {len(collector.events)} deletions.", flush=True)
        else:
            print("No sweep push (no deletions, no device, or the type is off in Settings).", flush=True)
    except Exception as e:
        print(f"WARNING: Failed to send sweep digest: {e}", file=sys.stderr)

    return {
        "expired": len(expired),
        "deleted_spotify": deleted_spotify,
        "deleted_db": deleted_db,
        "failed": failed,
    }
