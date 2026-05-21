"""
Helpers for the Missed New Tracks playlist family.

Fetches followed artists from the Spotify API, ranks them by play count,
and surfaces unplayed tracks from releases published within a recency window.
"""

from datetime import datetime, timedelta, timezone

_MISSED_NEW_TRACKS_RECENCY_DAYS = 14
_MISSED_NEW_TRACKS_POPULAR_TOP_N = 20
_MISSED_NEW_TRACKS_OTHER_RANGE = (21, 1000)  # inclusive start, inclusive end


def fetch_followed_artists(sp) -> list[dict]:
    """Paginate /me/following?type=artist (limit=50, max 50 pages = 2500 artists).

    Returns list of dicts with keys: id, name, uri.
    """
    artists = []
    after = None
    for _ in range(50):
        kwargs: dict = {"limit": 50}
        if after:
            kwargs["after"] = after
        response = sp.current_user_followed_artists(**kwargs)
        page = response["artists"]
        items = page.get("items") or []
        for item in items:
            artists.append({"id": item["id"], "name": item["name"], "uri": item["uri"]})
        cursors = page.get("cursors") or {}
        after = cursors.get("after")
        if not after or len(items) < 50:
            break
    return artists


def rank_artists_by_plays(conn, artist_names: list[str]) -> list[str]:
    """Rank artist_names by total play count in spotify_plays, descending.

    DEFAULT RANKER for the missed-new-tracks feature.

    Replacement rankers (e.g. normalised popularity score) must match this
    exact signature — (conn, artist_names: list[str]) -> list[str] — so they
    can be passed as rank_fn to the playlist factories without further changes.

    Artists with zero plays in spotify_plays are appended after ranked artists
    in their original input order (they are followed but untracked).
    """
    if not artist_names:
        return []
    cur = conn.cursor()
    cur.execute(
        """
        SELECT artist_name, COUNT(*) AS plays
        FROM spotify_plays
        WHERE artist_name = ANY(%s)
          AND artist_name IS NOT NULL
        GROUP BY artist_name
        ORDER BY plays DESC
        """,
        (artist_names,),
    )
    ranked = [row[0] for row in cur.fetchall()]
    ranked_set = set(ranked)
    unranked = [n for n in artist_names if n not in ranked_set]
    return ranked + unranked


def fetch_recent_releases_for_artist(
    sp, artist_id: str, days_window: int = 14
) -> list[dict]:
    """Fetch releases for an artist published within days_window days.

    Calls /artists/{id}/albums?include_groups=album,single&market=NL&limit=10.
    Results are release_date DESC; short-circuits on the first album older than
    the window. For each qualifying album, also fetches its track URIs.

    Returns list of {album_id, release_date, track_uris: [...]}.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_window)
    results = []

    try:
        response = sp.artist_albums(
            artist_id,
            album_type="album,single",
            country="NL",
            limit=10,
        )
    except Exception:
        return []

    for album in response.get("items") or []:
        raw_date = album.get("release_date", "")
        precision = album.get("release_date_precision", "day")
        try:
            if precision == "day":
                release_dt = datetime.strptime(raw_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            elif precision == "month":
                release_dt = datetime.strptime(raw_date + "-01", "%Y-%m-%d").replace(tzinfo=timezone.utc)
            else:
                release_dt = datetime.strptime(raw_date + "-01-01", "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue

        if release_dt < cutoff:
            break  # list is release_date DESC — nothing further will qualify

        track_uris = _fetch_album_track_uris(sp, album["id"])
        if track_uris:
            results.append({
                "album_id": album["id"],
                "release_date": raw_date,
                "track_uris": track_uris,
            })

    return results


def _fetch_album_track_uris(sp, album_id: str) -> list[str]:
    """Fetch all track URIs for an album, handling pagination."""
    uris = []
    offset = 0
    while True:
        try:
            page = sp.album_tracks(album_id, limit=50, offset=offset)
        except Exception:
            break
        items = page.get("items") or []
        for track in items:
            if track and track.get("uri"):
                uris.append(track["uri"])
        if len(items) < 50 or not page.get("next"):
            break
        offset += 50
    return uris


def find_missed_tracks(
    conn,
    sp,
    artist_names: list[str],
    artist_id_by_name: dict[str, str],
    days_window: int = 14,
) -> list[str]:
    """For each artist, fetch recent releases and filter out already-played tracks.

    Returns deduplicated unplayed track_uris in release-date-DESC order
    (newest releases first, preserving per-album track order within each release).
    Logs progress every 50 artists so the run is visibly alive.
    """
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT track_uri FROM spotify_plays WHERE track_uri IS NOT NULL")
    played_uris = {row[0] for row in cur.fetchall()}

    seen: set[str] = set()
    result: list[str] = []
    total = len(artist_names)

    for i, name in enumerate(artist_names, start=1):
        if i % 50 == 0:
            print(f"[missed_new_tracks] {i}/{total} artists processed...", flush=True)

        artist_id = artist_id_by_name.get(name)
        if not artist_id:
            continue

        for release in fetch_recent_releases_for_artist(sp, artist_id, days_window=days_window):
            for uri in release["track_uris"]:
                if uri not in played_uris and uri not in seen:
                    seen.add(uri)
                    result.append(uri)

    return result
