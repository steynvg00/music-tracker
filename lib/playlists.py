import psycopg

# Playlist helpers for music-tracker.
#
# SAFETY CONTRACT: modification calls (playlist_replace_items, playlist_add_items)
# are ONLY ever made on the playlist id returned by find_or_create_managed_playlist.
# The following spotipy methods are explicitly forbidden in this module and must
# never be added: playlist_change_details, playlist_remove_all_occurrences_of_items,
# playlist_remove_specific_occurrences_of_items, user_playlist_remove_*,
# current_user_unfollow_playlist.

MANAGED_PLAYLIST_NAME = "[test] music-tracker — 50+ plays"


def find_or_create_managed_playlist(sp, user_id: str) -> str:
    """Return the id of the managed playlist, creating it if it doesn't exist."""
    print("[playlists] Listing user playlists (paginated)...", flush=True)
    offset = 0
    target_id = None
    n = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        items = page["items"]
        print(f"[playlists]   page {n}: {len(items)} playlists fetched", flush=True)
        for pl in items:
            if pl["name"] == MANAGED_PLAYLIST_NAME and pl["owner"]["id"] == user_id:
                target_id = pl["id"]
                break
        if target_id or page["next"] is None:
            break
        offset += 50
        n += 1
    print("[playlists] Found existing managed playlist." if target_id else "[playlists] No existing playlist, will create new.", flush=True)
    if target_id:
        return target_id

    new = sp.user_playlist_create(
        user=user_id,
        name=MANAGED_PLAYLIST_NAME,
        public=False,
        description="Auto-managed by music-tracker. Do not edit manually.",
    )
    return new["id"]


def ensure_track_spotify_id(sp, cur, track_id: int, artist: str, title: str) -> str | None:
    """Return the Spotify track id for a track, searching if needed.

    Updates the tracks row in DB (caller must commit).
    Returns None if no Spotify match exists.
    """
    cur.execute("SELECT spotify_id, spotify_searched FROM tracks WHERE id = %s", (track_id,))
    row = cur.fetchone()
    if row is None:
        return None
    spotify_id, searched = row

    if spotify_id:
        return spotify_id
    if searched:
        return None

    safe_artist = artist.replace('"', "")
    safe_title = title.replace('"', "")
    query = f'track:"{safe_title}" artist:"{safe_artist}"'
    results = sp.search(q=query, type="track", limit=1)
    items = results["tracks"]["items"]

    if items:
        found_id = items[0]["id"]
        try:
            cur.execute(
                "UPDATE tracks SET spotify_id = %s, spotify_searched = TRUE WHERE id = %s",
                (found_id, track_id),
            )
            return found_id
        except psycopg.errors.UniqueViolation:
            cur.connection.rollback()
            cur.execute(
                "UPDATE tracks SET spotify_searched = TRUE WHERE id = %s",
                (track_id,),
            )
            cur.connection.commit()
            print(f"Duplicate Spotify ID {found_id} for track {artist} — {title}; skipping")
            return None
    else:
        cur.execute(
            "UPDATE tracks SET spotify_searched = TRUE WHERE id = %s",
            (track_id,),
        )
        return None


def replace_playlist_tracks(sp, playlist_id: str, uris: list[str]) -> None:
    """Replace the playlist's tracks with the given URIs."""
    print(f"[playlists] Replacing playlist contents with {len(uris)} tracks...", flush=True)
    if not uris:
        sp.playlist_replace_items(playlist_id, [])
        print("[playlists] Replace complete.", flush=True)
        return

    sp.playlist_replace_items(playlist_id, uris[:100])
    for i in range(100, len(uris), 100):
        batch = uris[i : i + 100]
        print(f"[playlists]   Adding batch of {len(batch)} tracks...", flush=True)
        sp.playlist_add_items(playlist_id, batch)
        print("[playlists]   Batch added.", flush=True)
    print("[playlists] Replace complete.", flush=True)
