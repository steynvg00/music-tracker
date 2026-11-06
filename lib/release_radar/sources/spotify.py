"""Release radar source 1: Spotify Web API, GET /artists/{id}/albums (album + single).

Uses the CRON app token (lib/spotify.get_spotify_client, same as lib/missed_new_tracks.py).
Availability: the endpoint is NOT on the Feb 2026 Development Mode removal list
(docs/hub-redesign/01-feasibility.md §0.1: removed are the BATCH /artists, /artists/{id}/top-tracks,
/browse/new-releases, …), and lib/missed_new_tracks.py already calls it daily in production with
this Client ID. So the adapter is enabled.

Spotify lists releases only once they are out, so this source gives "out" items: release dates
from RECENT_DAYS ago until today. For releases from the last PLAYLIST_DAYS days the album's track
URIs are stored too ("New from your artists · Auto 🤖🔄").
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from lib.release_radar.model import RadarArtist, ReleaseItem, SourceResult

NAME = "spotify"
LABEL = "Spotify"
RECENT_DAYS = 60
PLAYLIST_DAYS = 14
ALBUMS_PER_ARTIST = 10


def _parse_date(raw: str | None, precision: str | None) -> tuple[date | None, str | None]:
    try:
        if precision == "day":
            return datetime.strptime(raw or "", "%Y-%m-%d").date(), "day"
        if precision == "month":
            return datetime.strptime((raw or "") + "-01", "%Y-%m-%d").date(), "month"
        return datetime.strptime((raw or "") + "-01-01", "%Y-%m-%d").date(), "year"
    except ValueError:
        return None, None


def _album_tracks(sp, album_id: str) -> list[str]:
    out: list[str] = []
    offset = 0
    while True:
        page = sp.album_tracks(album_id, limit=50, offset=offset) or {}
        items = page.get("items") or []
        out += [t["uri"] for t in items if t and str(t.get("uri", "")).startswith("spotify:track:")]
        if len(items) < 50 or not page.get("next"):
            return out
        offset += 50


def fetch(artists: list[RadarArtist], *, sp, today: date) -> SourceResult:
    res = SourceResult(items=[])
    oldest = today - timedelta(days=RECENT_DAYS)
    with_id = [a for a in artists if a.spotify_id]
    for a in with_id:
        res.requests += 1
        try:
            page = sp.artist_albums(a.spotify_id, album_type="album,single", country="NL", limit=ALBUMS_PER_ARTIST) or {}
        except Exception as e:  # one artist failing never stops the run
            res.errors.append(f"{a.name}: {type(e).__name__}: {e}"[:200])
            continue
        for al in page.get("items") or []:
            d, prec = _parse_date(al.get("release_date"), al.get("release_date_precision"))
            if d is None or d < oldest or d > today or prec != "day":
                continue
            uris: list[str] = []
            if (today - d).days <= PLAYLIST_DAYS:
                res.requests += 1
                try:
                    uris = _album_tracks(sp, al["id"])
                except Exception as e:
                    res.errors.append(f"{al.get('name')}: tracks: {type(e).__name__}"[:200])
            res.items.append(ReleaseItem(
                source=NAME, external_id=al["id"], artist_key=a.key, artist_name=a.name, artist_id=a.spotify_id,
                title=al.get("name") or "", release_date=d, precision=prec,
                url=(al.get("external_urls") or {}).get("spotify") or f"https://open.spotify.com/album/{al['id']}",
                release_type=al.get("album_type"), spotify_album_id=al["id"], track_uris=uris,
            ))
    res.detail = {"artists": len(with_id), "errors": len(res.errors)}
    if with_id and len(res.errors) >= len(with_id):
        res.fatal = res.errors[0] if res.errors else "every request failed"
    return res
