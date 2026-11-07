"""Release radar (v0.87, R7): which artists the radar follows.

  * Your top TOP_ARTISTS artists by plays over the last WINDOW_MONTHS months, counting every
    credited artist (track_metadata.artist_ids, like Stats › Artist detail), and
  * every artist you marked "Follow in Rotor" (radar_followed_artists), whatever their plays.
"""
from __future__ import annotations

from lib.release_radar.match import norm_artist
from lib.release_radar.model import RadarArtist

TOP_ARTISTS = 200
WINDOW_MONTHS = 24


def radar_artists(conn, top: int = TOP_ARTISTS, months: int = WINDOW_MONTHS) -> list[RadarArtist]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT u.artist_id, max(u.artist_name) AS name, count(*)::int AS plays
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        CROSS JOIN LATERAL unnest(tm.artist_ids, tm.artist_names) AS u(artist_id, artist_name)
        WHERE sp.played_at >= now() - make_interval(months => %s) AND u.artist_id IS NOT NULL AND u.artist_name IS NOT NULL
        GROUP BY u.artist_id
        ORDER BY plays DESC, name
        LIMIT %s
        """,
        (months, top),
    )
    out: dict[str, RadarArtist] = {}
    for aid, name, plays in cur.fetchall():
        out[aid] = RadarArtist(key=norm_artist(name), name=name, spotify_id=aid, plays=plays)
    cur.execute("SELECT artist_id, name FROM radar_followed_artists ORDER BY followed_at")
    for aid, name in cur.fetchall():
        prev = out.get(aid)
        out[aid] = RadarArtist(key=norm_artist(name), name=prev.name if prev else name, spotify_id=aid,
                               plays=prev.plays if prev else 0, followed=True)
    return [a for a in out.values() if a.key]
