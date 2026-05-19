"""Generate/refresh the [test] 50+ plays Spotify playlist from scrobble data."""

from lib.db import get_connection
from lib.spotify import get_spotify_client
from lib.playlists import (
    MANAGED_PLAYLIST_NAME,
    ensure_track_spotify_id,
    find_or_create_managed_playlist,
    replace_playlist_tracks,
)

TOP_TRACKS_SQL = """
    SELECT t.id, a.name AS artist, t.title, t.spotify_id, t.spotify_searched, COUNT(s.id) AS plays
    FROM scrobbles s
    JOIN tracks t ON t.id = s.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE s.source = 'lastfm'
    GROUP BY t.id, a.name, t.title, t.spotify_id, t.spotify_searched
    HAVING COUNT(s.id) >= 50
    ORDER BY plays DESC
"""


def main() -> None:
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(TOP_TRACKS_SQL)
            candidates = cur.fetchall()

        print(f"Found {len(candidates)} tracks with >= 50 plays")

        uris: list[str] = []
        skipped = 0

        for i, (track_id, artist, title, _spotify_id, _searched, _plays) in enumerate(candidates):
            with conn.cursor() as cur:
                sid = ensure_track_spotify_id(sp, cur, track_id, artist, title)
            conn.commit()

            if sid:
                uris.append(f"spotify:track:{sid}")
            else:
                skipped += 1

            if (i + 1) % 20 == 0:
                print(f"  Processed {i + 1}/{len(candidates)} tracks...")

        print(f"Skipped {skipped} tracks not found on Spotify")

        playlist_id = find_or_create_managed_playlist(sp, user_id)
        replace_playlist_tracks(sp, playlist_id, uris)

        print(f"Playlist updated: {MANAGED_PLAYLIST_NAME} ({len(uris)} tracks added)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
