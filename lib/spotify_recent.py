"""Fetch and ingest the last 50 Spotify recently-played tracks via the Web API."""

from datetime import datetime, timezone

import psycopg

from lib.spotify import get_spotify_client

_INSERT_SQL = """
    INSERT INTO spotify_plays (
        played_at, track_uri, track_name, artist_name, album_name,
        ms_played, platform, country,
        episode_uri, episode_name, show_name,
        audiobook_uri, audiobook_title, audiobook_chapter_uri, audiobook_chapter_title,
        reason_start, reason_end, shuffle, skipped, offline, offline_timestamp, incognito_mode
    ) VALUES (
        %(played_at)s, %(track_uri)s, %(track_name)s, %(artist_name)s, %(album_name)s,
        %(ms_played)s, %(platform)s, %(country)s,
        %(episode_uri)s, %(episode_name)s, %(show_name)s,
        %(audiobook_uri)s, %(audiobook_title)s, %(audiobook_chapter_uri)s, %(audiobook_chapter_title)s,
        %(reason_start)s, %(reason_end)s, %(shuffle)s, %(skipped)s, %(offline)s,
        %(offline_timestamp)s, %(incognito_mode)s
    )
    ON CONFLICT (played_at, track_uri) WHERE track_uri IS NOT NULL DO NOTHING
"""


def fetch_recent_plays(sp) -> list[dict]:
    """Call spotipy.current_user_recently_played(limit=50) and normalize each item
    to a dict matching spotify_plays schema. Rich fields stay None.
    Returns list of dicts ready for ingest_records."""
    response = sp.current_user_recently_played(limit=50)
    records = []
    for item in response.get("items", []):
        track = item.get("track") or {}
        artists = track.get("artists") or []
        album = track.get("album") or {}

        ts = item.get("played_at")
        if isinstance(ts, str):
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = ts

        records.append({
            "played_at":              dt,
            "track_uri":              track.get("uri"),
            "track_name":             track.get("name"),
            "artist_name":            artists[0]["name"] if artists else None,
            "album_name":             album.get("name"),
            "ms_played":              None,
            "platform":               None,
            "country":                None,
            "episode_uri":            None,
            "episode_name":           None,
            "show_name":              None,
            "audiobook_uri":          None,
            "audiobook_title":        None,
            "audiobook_chapter_uri":  None,
            "audiobook_chapter_title": None,
            "reason_start":           None,
            "reason_end":             None,
            "shuffle":                None,
            "skipped":                None,
            "offline":                None,
            "offline_timestamp":      None,
            "incognito_mode":         None,
        })
    return records


def ingest_recent(conn) -> dict:
    """Top-level entry. Gets spotipy client via lib.spotify.get_spotify_client(),
    fetches recent plays, inserts via INSERT ... ON CONFLICT (played_at, track_uri)
    WHERE track_uri IS NOT NULL DO NOTHING.
    Returns dict with keys: attempted, inserted, skipped."""
    sp = get_spotify_client()
    records = fetch_recent_plays(sp)
    attempted = len(records)
    if attempted == 0:
        return {"attempted": 0, "inserted": 0, "skipped": 0}

    with conn.cursor() as cur:
        cur.executemany(_INSERT_SQL, records)
        inserted = cur.rowcount if cur.rowcount >= 0 else 0

    conn.commit()
    skipped = attempted - inserted
    # Deduplicated non-null track_uris seen in this batch. Consumed by the badge
    # milestone detector (v0.63); ON CONFLICT means we can't cheaply tell which
    # rows were newly inserted, but batch-scoped detection is idempotent so
    # passing the full recently-played set is correct and safe.
    batch_track_uris = sorted({r["track_uri"] for r in records if r["track_uri"]})
    return {
        "attempted": attempted,
        "inserted": inserted,
        "skipped": skipped,
        "track_uris": batch_track_uris,
    }
