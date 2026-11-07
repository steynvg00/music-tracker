"""Release radar source 2: MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API).

Per radar artist:
  1. Map Spotify artist → MusicBrainz artist once (cached in radar_mb_artists, rechecked after
     30 days when unmatched):
       a. URL relationship: GET /ws/2/url?resource=https://open.spotify.com/artist/<id>&inc=artist-rels
       b. else a name search, accepted only when exactly one artist has the same normalised name
          with score ≥ 95 (no guessing between namesakes).
     At most MAX_LOOKUPS new look-ups per run, so the first run stays short; the rest follow on
     the next days.
  2. Releases dated from RECENT_DAYS ago to AHEAD_DAYS ahead:
       GET /ws/2/release?query=arid:<mbid> AND date:[from TO to]
     grouped by release group (one item per release, not per CD/digital edition), earliest date.

Rate: under 1 request/second through PoliteHttp (1.1 s gap). User-Agent per lib/release_radar/http.py.
Base URL: RADAR_MUSICBRAINZ_BASE (default https://musicbrainz.org/ws/2); the E2E run points it at a mock.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta

from lib.release_radar.match import norm_artist
from lib.release_radar.model import RadarArtist, ReleaseItem, SourceResult

NAME = "musicbrainz"
LABEL = "MusicBrainz"
RECENT_DAYS = 60
AHEAD_DAYS = 366
MAX_LOOKUPS = 60
RECHECK_UNMATCHED_DAYS = 30


def base_url() -> str:
    return os.environ.get("RADAR_MUSICBRAINZ_BASE", "https://musicbrainz.org/ws/2").rstrip("/")


def _parse(raw: str | None) -> tuple[date | None, str | None]:
    raw = (raw or "").strip()
    for fmt, prec in (("%Y-%m-%d", "day"), ("%Y-%m", "month"), ("%Y", "year")):
        try:
            return datetime.strptime(raw, fmt).date(), prec
        except ValueError:
            continue
    return None, None


def lookup_by_spotify(http, spotify_id: str) -> tuple[str, str] | None:
    r = http.get(f"{base_url()}/url", params={"resource": f"https://open.spotify.com/artist/{spotify_id}", "inc": "artist-rels", "fmt": "json"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    for rel in r.json().get("relations") or []:
        a = rel.get("artist") or {}
        if a.get("id"):
            return a["id"], a.get("name") or ""
    return None


def lookup_by_name(http, name: str) -> tuple[str, str] | None:
    r = http.get(f"{base_url()}/artist", params={"query": f'artist:"{name}"', "fmt": "json", "limit": "5"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    key = norm_artist(name)
    hits = [a for a in r.json().get("artists") or [] if int(a.get("score") or 0) >= 95 and norm_artist(a.get("name") or "") == key]
    return (hits[0]["id"], hits[0].get("name") or name) if len(hits) == 1 else None


def resolve(conn, http, artists: list[RadarArtist], res: SourceResult) -> dict[str, str]:
    """artist key → mbid for every artist we can map (cache first, then ≤ MAX_LOOKUPS look-ups)."""
    cur = conn.cursor()
    ids = [a.spotify_id or f"name:{a.key}" for a in artists]
    cur.execute("SELECT artist_ref, mbid, checked_at FROM radar_mb_artists WHERE artist_ref = ANY(%s)", (ids,))
    cached = {ref: (mbid, checked) for ref, mbid, checked in cur.fetchall()}
    out: dict[str, str] = {}
    lookups = 0
    stale = datetime.now().astimezone() - timedelta(days=RECHECK_UNMATCHED_DAYS)
    for a, ref in zip(artists, ids):
        hit = cached.get(ref)
        if hit and (hit[0] or hit[1] > stale):
            if hit[0]:
                out[a.key] = hit[0]
            continue
        if lookups >= MAX_LOOKUPS:
            continue
        lookups += 1
        found, how = None, None
        try:
            if a.spotify_id:
                res.requests += 1
                found, how = lookup_by_spotify(http, a.spotify_id), "spotify_url"
            if not found:
                res.requests += 1
                found, how = lookup_by_name(http, a.name), "name"
        except Exception as e:
            res.errors.append(f"lookup {a.name}: {type(e).__name__}: {e}"[:200])
            continue
        cur.execute(
            """INSERT INTO radar_mb_artists (artist_ref, name, mbid, mb_name, matched_by, checked_at)
               VALUES (%s, %s, %s, %s, %s, now())
               ON CONFLICT (artist_ref) DO UPDATE SET mbid = EXCLUDED.mbid, mb_name = EXCLUDED.mb_name,
                   matched_by = EXCLUDED.matched_by, checked_at = now()""",
            (ref, a.name, found[0] if found else None, found[1] if found else None, how if found else None),
        )
        if found:
            out[a.key] = found[0]
    conn.commit()
    res.detail["lookups"] = lookups
    return out


def fetch(conn, artists: list[RadarArtist], *, http, today: date) -> SourceResult:
    res = SourceResult(items=[])
    mapped = resolve(conn, http, artists, res)
    by_key = {a.key: a for a in artists}
    frm, to = today - timedelta(days=RECENT_DAYS), today + timedelta(days=AHEAD_DAYS)
    queried = 0
    for key, mbid in mapped.items():
        a = by_key[key]
        queried += 1
        res.requests += 1
        try:
            r = http.get(f"{base_url()}/release", params={"query": f"arid:{mbid} AND date:[{frm} TO {to}]", "fmt": "json", "limit": "50"})
            r.raise_for_status()
            releases = r.json().get("releases") or []
        except Exception as e:
            res.errors.append(f"{a.name}: {type(e).__name__}: {e}"[:200])
            continue
        groups: dict[str, ReleaseItem] = {}
        for rel in releases:
            d, prec = _parse(rel.get("date"))
            if d is None or d < frm or d > to:
                continue
            rg = rel.get("release-group") or {}
            gid = rg.get("id") or rel.get("id")
            labels = [li.get("label", {}).get("name") for li in rel.get("label-info") or [] if (li.get("label") or {}).get("name")]
            item = ReleaseItem(
                source=NAME, external_id=gid, artist_key=a.key, artist_name=a.name, artist_id=a.spotify_id,
                title=rel.get("title") or rg.get("title") or "", release_date=d, precision=prec,
                url=f"https://musicbrainz.org/release-group/{gid}" if rg.get("id") else f"https://musicbrainz.org/release/{rel.get('id')}",
                release_type=(rg.get("primary-type") or "").lower() or None, label=labels[0] if labels else None,
            )
            prev = groups.get(gid)
            if prev is None or (d < prev.release_date) or (prev.precision != "day" and prec == "day"):
                groups[gid] = item
        res.items += groups.values()
    res.detail.update({"mapped": len(mapped), "queried": queried, "errors": len(res.errors)})
    if artists and (res.requests and len(res.errors) >= res.requests):
        res.fatal = res.errors[0] if res.errors else "every request failed"
    return res
