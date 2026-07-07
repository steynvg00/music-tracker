"""
Helpers for the Missed New Tracks playlist family.

Fetches followed artists from the Spotify API, ranks them by play count,
and surfaces unplayed tracks from releases published within a recency window.
"""

from datetime import datetime, timedelta, timezone

# v0.72: releases enter the playlist only once they are MIN_AGE days old (a delay so the
# user's own fast day-0..day-7 listening — 40.1% of eventual plays land within 7 days, per
# docs/playlist_system.md — plays out first), and drop out once older than MAX_AGE days
# (~2 months). Popular-vs-other is a classifier: a release is "popular" if any of its
# credited artist ids is in the user's top-N most-played artists over the trailing window.
_MISSED_NEW_TRACKS_MIN_AGE_DAYS = 7
_MISSED_NEW_TRACKS_MAX_AGE_DAYS = 60
_MISSED_NEW_TRACKS_POPULAR_TOP_N = 50
_MISSED_NEW_TRACKS_POPULAR_WINDOW_DAYS = 730  # 2 years


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


def top_played_artist_ids(
    conn, top_n: int = 50, window_days: int = 730
) -> set[str]:
    """The user's top-N most-played artist_ids over the trailing window (v0.72).

    Aggregates per artist_id by unnesting track_metadata.artist_ids joined to
    spotify_plays (spotify_plays itself has no artist_id). Used as the popular-vs-other
    classifier for the Missed New Tracks playlists.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT aid, COUNT(*) AS plays
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        CROSS JOIN LATERAL unnest(tm.artist_ids) AS aid
        WHERE sp.track_uri IS NOT NULL
          AND sp.played_at >= NOW() - make_interval(days => %s)
        GROUP BY aid
        ORDER BY plays DESC
        LIMIT %s
        """,
        (window_days, top_n),
    )
    return {row[0] for row in cur.fetchall()}


def _parse_release_dt(raw_date: str, precision: str) -> datetime | None:
    """Parse a Spotify release_date + precision into a UTC datetime (None on failure)."""
    try:
        if precision == "day":
            return datetime.strptime(raw_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if precision == "month":
            return datetime.strptime(raw_date + "-01", "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return datetime.strptime(raw_date + "-01-01", "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def fetch_recent_release_tracks_for_artist(
    sp, artist_id: str, min_age_days: int, max_age_days: int
) -> list[dict]:
    """Tracks on this artist's albums released in the age window [min_age, max_age] days.

    A release is included only when it is at least ``min_age_days`` old (the delay) and
    at most ``max_age_days`` old (the expiry). Albums come back release_date DESC, so we
    skip the too-new ones and break once past the window. Each returned dict is
    {"uri": str, "artist_ids": [str, ...]} for classifier use.
    """
    now = datetime.now(timezone.utc)
    newest_allowed = now - timedelta(days=min_age_days)  # release_dt must be <= this
    oldest_allowed = now - timedelta(days=max_age_days)  # release_dt must be >= this

    try:
        response = sp.artist_albums(
            artist_id,
            album_type="album,single",
            country="NL",
            limit=20,
        )
    except Exception:
        return []

    results: list[dict] = []
    for album in response.get("items") or []:
        release_dt = _parse_release_dt(
            album.get("release_date", ""), album.get("release_date_precision", "day")
        )
        if release_dt is None:
            continue
        if release_dt > newest_allowed:
            continue  # inside the delay window — too new to add yet, keep scanning older
        if release_dt < oldest_allowed:
            break  # past the expiry window; list is DESC so nothing further qualifies
        results.extend(_fetch_album_tracks(sp, album["id"]))
    return results


def _fetch_album_tracks(sp, album_id: str) -> list[dict]:
    """All tracks on an album as {"uri", "artist_ids"} dicts, handling pagination."""
    out: list[dict] = []
    offset = 0
    while True:
        try:
            page = sp.album_tracks(album_id, limit=50, offset=offset)
        except Exception:
            break
        items = page.get("items") or []
        for track in items:
            if track and track.get("uri"):
                artist_ids = [a["id"] for a in (track.get("artists") or []) if a.get("id")]
                out.append({"uri": track["uri"], "artist_ids": artist_ids})
        if len(items) < 50 or not page.get("next"):
            break
        offset += 50
    return out


def find_missed_tracks_classified(
    conn,
    sp,
    followed_artists: list[dict],
    popular_ids: set[str],
    min_age_days: int = _MISSED_NEW_TRACKS_MIN_AGE_DAYS,
    max_age_days: int = _MISSED_NEW_TRACKS_MAX_AGE_DAYS,
) -> tuple[list[str], list[str]]:
    """Scan every followed artist's recent releases; return (popular_uris, other_uris).

    A track qualifies when it is unplayed and released in the [min_age, max_age] window.
    It goes to `popular` if ANY of its credited artist_ids is in `popular_ids`, else to
    `other`. Deduplicated across artists, release-date-DESC order preserved. Logs every
    50 artists so the run is visibly alive.
    """
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT track_uri FROM spotify_plays WHERE track_uri IS NOT NULL")
    played_uris = {row[0] for row in cur.fetchall()}

    seen: set[str] = set()
    popular: list[str] = []
    other: list[str] = []
    total = len(followed_artists)

    for i, artist in enumerate(followed_artists, start=1):
        if i % 50 == 0:
            print(f"[missed_new_tracks] {i}/{total} artists processed...", flush=True)

        artist_id = artist.get("id")
        if not artist_id:
            continue

        for track in fetch_recent_release_tracks_for_artist(
            sp, artist_id, min_age_days, max_age_days
        ):
            uri = track["uri"]
            if uri in played_uris or uri in seen:
                continue
            seen.add(uri)
            if popular_ids.intersection(track["artist_ids"]):
                popular.append(uri)
            else:
                other.append(uri)

    return popular, other
