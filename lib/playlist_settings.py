"""CRUD helpers and ordering logic for per-playlist settings (playlist_settings table)."""

import random as _random
import warnings

ORDER_PREF_OPTIONS: dict[str, str] = {
    "default":        "Default (factory order)",
    "plays_desc":     "Most plays first",
    "plays_asc":      "Least plays first",
    "recency_desc":   "Most recently played first",
    "recency_asc":    "Least recently played first",
    "discovery_desc": "Most recently discovered first",
    "discovery_asc":  "Earliest discovered first",
    "release_desc":   "Newest releases first",
    "release_asc":    "Oldest releases first",
    "random":         "Random shuffle",
}

_SETTINGS_COLS = [
    "playlist_id", "playlist_name", "order_pref",
    "force_refresh_requested_at", "force_refresh_completed_at",
    "created_at", "updated_at",
]


def get_settings(conn, playlist_id: str) -> dict | None:
    """Return the settings row for a playlist, or None if no row exists."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT playlist_id, playlist_name, order_pref,
               force_refresh_requested_at, force_refresh_completed_at,
               created_at, updated_at
        FROM playlist_settings WHERE playlist_id = %s
        """,
        (playlist_id,),
    )
    row = cur.fetchone()
    return dict(zip(_SETTINGS_COLS, row)) if row else None


def get_all_settings(conn) -> dict[str, dict]:
    """Bulk fetch all settings rows, keyed by playlist_id."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT playlist_id, playlist_name, order_pref,
               force_refresh_requested_at, force_refresh_completed_at,
               created_at, updated_at
        FROM playlist_settings
        """
    )
    return {row[0]: dict(zip(_SETTINGS_COLS, row)) for row in cur.fetchall()}


def get_all_settings_by_name(conn) -> dict[str, dict]:
    """Bulk fetch all settings rows, keyed by playlist_name (for dashboard lookup)."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT playlist_id, playlist_name, order_pref,
               force_refresh_requested_at, force_refresh_completed_at,
               created_at, updated_at
        FROM playlist_settings
        """
    )
    result = {}
    for row in cur.fetchall():
        d = dict(zip(_SETTINGS_COLS, row))
        if d["playlist_name"]:
            result[d["playlist_name"]] = d
    return result


def upsert_order_pref(conn, playlist_id: str, playlist_name: str, order_pref: str) -> None:
    """Persist order_pref for a playlist. conn should be a fresh psycopg.connect() from caller."""
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO playlist_settings (playlist_id, playlist_name, order_pref)
        VALUES (%s, %s, %s)
        ON CONFLICT (playlist_id) DO UPDATE
            SET playlist_name = EXCLUDED.playlist_name,
                order_pref    = EXCLUDED.order_pref,
                updated_at    = NOW()
        """,
        (playlist_id, playlist_name, order_pref),
    )
    conn.commit()


def request_force_refresh(conn, playlist_id: str, playlist_name: str) -> None:
    """Mark a snapshot playlist for force-refresh on next cron run.

    conn should be a fresh psycopg.connect() from the Streamlit handler.
    """
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO playlist_settings (playlist_id, playlist_name, force_refresh_requested_at)
        VALUES (%s, %s, NOW())
        ON CONFLICT (playlist_id) DO UPDATE
            SET playlist_name               = EXCLUDED.playlist_name,
                force_refresh_requested_at  = NOW(),
                updated_at                  = NOW()
        """,
        (playlist_id, playlist_name),
    )
    conn.commit()


def mark_force_refresh_completed(conn, playlist_id: str) -> None:
    """Record that a force-refresh was applied. Called from the cron script."""
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE playlist_settings
        SET force_refresh_completed_at = NOW(),
            updated_at                 = NOW()
        WHERE playlist_id = %s
        """,
        (playlist_id,),
    )
    conn.commit()


def apply_ordering(conn, track_uris: list[str], order_pref: str) -> list[str]:
    """Reorder track_uris according to order_pref.

    'default' returns the list unchanged. 'random' shuffles in-place.
    All other options query spotify_plays or track_metadata for sort keys.
    Falls back to default (with a warning) if release_* is requested but
    no track_metadata rows are found for the given URIs.
    """
    if not track_uris or order_pref == "default":
        return track_uris

    if order_pref == "random":
        shuffled = list(track_uris)
        _random.shuffle(shuffled)
        return shuffled

    cur = conn.cursor()

    if order_pref in ("plays_desc", "plays_asc"):
        direction = "DESC" if order_pref == "plays_desc" else "ASC"
        cur.execute(
            f"""
            SELECT u.uri
            FROM unnest(%s::text[]) WITH ORDINALITY AS u(uri, pos)
            LEFT JOIN (
                SELECT track_uri, COUNT(*) AS plays
                FROM spotify_plays
                WHERE track_uri = ANY(%s) AND track_uri IS NOT NULL
                GROUP BY track_uri
            ) sp ON sp.track_uri = u.uri
            ORDER BY COALESCE(sp.plays, 0) {direction}, u.pos
            """,
            (track_uris, track_uris),
        )
        return [row[0] for row in cur.fetchall()]

    if order_pref in ("recency_desc", "recency_asc"):
        direction = "DESC" if order_pref == "recency_desc" else "ASC"
        cur.execute(
            f"""
            SELECT u.uri
            FROM unnest(%s::text[]) WITH ORDINALITY AS u(uri, pos)
            LEFT JOIN (
                SELECT track_uri, MAX(played_at) AS last_play
                FROM spotify_plays
                WHERE track_uri = ANY(%s) AND track_uri IS NOT NULL
                GROUP BY track_uri
            ) sp ON sp.track_uri = u.uri
            ORDER BY sp.last_play {direction} NULLS LAST, u.pos
            """,
            (track_uris, track_uris),
        )
        return [row[0] for row in cur.fetchall()]

    if order_pref in ("discovery_desc", "discovery_asc"):
        direction = "DESC" if order_pref == "discovery_desc" else "ASC"
        cur.execute(
            f"""
            SELECT u.uri
            FROM unnest(%s::text[]) WITH ORDINALITY AS u(uri, pos)
            LEFT JOIN (
                SELECT track_uri, MIN(played_at) AS first_play
                FROM spotify_plays
                WHERE track_uri = ANY(%s) AND track_uri IS NOT NULL
                GROUP BY track_uri
            ) sp ON sp.track_uri = u.uri
            ORDER BY sp.first_play {direction} NULLS LAST, u.pos
            """,
            (track_uris, track_uris),
        )
        return [row[0] for row in cur.fetchall()]

    if order_pref in ("release_desc", "release_asc"):
        direction = "DESC" if order_pref == "release_desc" else "ASC"
        cur.execute(
            f"""
            SELECT u.uri, (tm.release_date IS NOT NULL) AS has_meta
            FROM unnest(%s::text[]) WITH ORDINALITY AS u(uri, pos)
            LEFT JOIN track_metadata tm ON tm.track_uri = u.uri
            ORDER BY tm.release_date {direction} NULLS LAST, u.pos
            """,
            (track_uris,),
        )
        rows = cur.fetchall()
        if not any(row[1] for row in rows):
            warnings.warn(
                f"apply_ordering: no release_date metadata for {len(track_uris)} tracks; "
                "falling back to default order"
            )
            return track_uris
        return [row[0] for row in rows]

    warnings.warn(f"apply_ordering: unknown order_pref {order_pref!r}; falling back to default")
    return track_uris
