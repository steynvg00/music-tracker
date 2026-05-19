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
    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        for pl in page["items"]:
            if pl["name"] == MANAGED_PLAYLIST_NAME and pl["owner"]["id"] == user_id:
                return pl["id"]
        if page["next"] is None:
            break
        offset += 50

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
        cur.execute(
            "UPDATE tracks SET spotify_id = %s, spotify_searched = TRUE WHERE id = %s",
            (found_id, track_id),
        )
        return found_id
    else:
        cur.execute(
            "UPDATE tracks SET spotify_searched = TRUE WHERE id = %s",
            (track_id,),
        )
        return None


def replace_playlist_tracks(sp, playlist_id: str, uris: list[str]) -> None:
    """Replace the playlist's tracks with the given URIs."""
    if not uris:
        sp.playlist_replace_items(playlist_id, [])
        return

    sp.playlist_replace_items(playlist_id, uris[:100])
    for i in range(100, len(uris), 100):
        sp.playlist_add_items(playlist_id, uris[i : i + 100])
