"""Elsewhere metadata refresh (v0.84, R4). YouTube API Services Developer Policies III.E.4:
stored API data must be refreshed or deleted within 30 days. Runs in the daily hub-jobs run
(lib/hub_jobs.run_daily) and by hand: `uv run python scripts/refresh_collections.py`.

  - YouTube playlists synced > 25 days ago are re-read (playlists + playlistItems + videos):
    new videos added, removed ones dropped, titles/durations/embeddable refreshed.
  - Any other YouTube item checked > 25 days ago is re-read with videos.list (50 per unit);
    a video that no longer comes back is marked unavailable (and re-checked like the rest).
  - Whatever still isn't refreshed after 30 days (no API key, API refusing) is DELETED, so
    Rotor never keeps YouTube API data longer than the policy allows.
  - SoundCloud sets synced > 25 days ago get a fresh oEmbed (title, artwork, widget html).

Network: YOUTUBE_API_KEY (GitHub secret); bases can be overridden for tests
(YOUTUBE_API_BASE, SOUNDCLOUD_OEMBED_URL). No Spotify calls.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from datetime import timedelta

YT_BASE = os.environ.get("YOUTUBE_API_BASE", "https://www.googleapis.com/youtube/v3").rstrip("/")
SC_OEMBED = os.environ.get("SOUNDCLOUD_OEMBED_URL", "https://soundcloud.com/oembed")
REFRESH_SOON = timedelta(days=25)
HARD_LIMIT = timedelta(days=30)
MAX_ITEMS = 500
_ISO = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def iso_duration_ms(iso: str | None) -> int | None:
    m = _ISO.match(iso or "")
    if not m or iso in ("P", "PT"):
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 3600 + mi * 60 + s) * 1000


def _get(url: str, params: dict, http=None) -> dict:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    if http is not None:
        return http(full)
    with urllib.request.urlopen(urllib.request.Request(full, headers={"Accept": "application/json"}), timeout=15) as r:
        return json.loads(r.read().decode())


def _thumb(t: dict | None) -> str | None:
    t = t or {}
    for k in ("medium", "high", "default"):
        if t.get(k, {}).get("url"):
            return t[k]["url"]
    return None


class YouTube:
    def __init__(self, key: str, http=None):
        self.key, self.http, self.units = key, http, 0

    def get(self, path: str, **params) -> dict:
        self.units += 1
        return _get(f"{YT_BASE}/{path}", {**params, "key": self.key}, self.http)

    def videos(self, ids: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(ids), 50):
            page = self.get("videos", part="snippet,contentDetails,status", id=",".join(ids[i:i + 50]), maxResults=50)
            for v in page.get("items", []):
                out[v["id"]] = v
        return out


def _upsert_video(cur, v: dict) -> str:
    sn, st = v.get("snippet", {}), v.get("status", {})
    cur.execute(
        """
        INSERT INTO media_items (source, source_id, title, artist_display, duration_ms, artwork_url, embeddable, unavailable, last_checked_at, raw)
        VALUES ('youtube', %s, %s, %s, %s, %s, %s, false, now(), %s::jsonb)
        ON CONFLICT (source, source_id) DO UPDATE SET
            title = EXCLUDED.title, artist_display = EXCLUDED.artist_display,
            duration_ms = coalesce(EXCLUDED.duration_ms, media_items.duration_ms), artwork_url = EXCLUDED.artwork_url,
            embeddable = EXCLUDED.embeddable, unavailable = false, last_checked_at = now(), raw = EXCLUDED.raw
        RETURNING id
        """,
        (v["id"], sn.get("title") or v["id"], sn.get("channelTitle"), iso_duration_ms(v.get("contentDetails", {}).get("duration")),
         _thumb(sn.get("thumbnails")), st.get("embeddable"), json.dumps({"privacyStatus": st.get("privacyStatus")})),
    )
    return cur.fetchone()[0]


def sync_youtube_playlist(conn, yt: YouTube, collection_id, playlist_id: str) -> int:
    """Re-read one playlist; returns the new item count. Raises on API errors (caller logs)."""
    cur = conn.cursor()
    pl = yt.get("playlists", part="snippet,contentDetails", id=playlist_id, maxResults=1).get("items", [])
    if not pl:
        # Gone or made private: keep nothing we can no longer refresh.
        cur.execute("DELETE FROM collections WHERE id = %s", (collection_id,))
        return 0
    sn = pl[0].get("snippet", {})
    ids, token = [], None
    while True:
        params = {"part": "contentDetails", "playlistId": playlist_id, "maxResults": 50}
        if token:
            params["pageToken"] = token
        page = yt.get("playlistItems", **params)
        ids += [it["contentDetails"]["videoId"] for it in page.get("items", []) if it.get("contentDetails", {}).get("videoId")]
        token = page.get("nextPageToken")
        if not token or len(ids) >= MAX_ITEMS:
            break
    ids = list(dict.fromkeys(ids))[:MAX_ITEMS]
    videos = yt.videos(ids)
    cur.execute("DELETE FROM collection_items WHERE collection_id = %s", (collection_id,))
    pos = 0
    for vid in ids:
        v = videos.get(vid)
        if not v:
            continue
        mid = _upsert_video(cur, v)
        cur.execute("INSERT INTO collection_items (collection_id, position, media_item_id) VALUES (%s, %s, %s)", (collection_id, pos, mid))
        pos += 1
    cur.execute(
        "UPDATE collections SET title = %s, owner_display = %s, artwork_url = %s, item_count = %s, last_synced_at = now(), last_import_units = %s WHERE id = %s",
        (sn.get("title") or "YouTube playlist", sn.get("channelTitle"), _thumb(sn.get("thumbnails")), pos, yt.units, collection_id),
    )
    return pos


def refresh(conn, *, key: str | None = None, http=None, sc_http=None) -> dict:
    """The daily refresh. Returns a summary for the job log."""
    key = key if key is not None else os.environ.get("YOUTUBE_API_KEY") or None
    cur = conn.cursor()
    summary = {"youtube_playlists": 0, "youtube_items": 0, "unavailable": 0, "deleted_stale": 0, "soundcloud": 0, "errors": [], "units": 0}
    if key:
        yt = YouTube(key, http)
        cur.execute(
            "SELECT id, source_collection_id FROM collections WHERE source = 'youtube' AND kind = 'playlist' AND last_synced_at < now() - %s",
            (REFRESH_SOON,),
        )
        for cid, pid in cur.fetchall():
            try:
                sync_youtube_playlist(conn, yt, cid, pid)
                conn.commit()
                summary["youtube_playlists"] += 1
            except Exception as e:  # noqa: BLE001 — one bad playlist mustn't stop the rest
                conn.rollback()
                summary["errors"].append(f"playlist {pid}: {e}")
        cur.execute("SELECT id, source_id FROM media_items WHERE source = 'youtube' AND last_checked_at < now() - %s", (REFRESH_SOON,))
        stale = cur.fetchall()
        try:
            got = yt.videos([sid for _, sid in stale])
            for mid, sid in stale:
                if sid in got:
                    _upsert_video(cur, got[sid])
                    summary["youtube_items"] += 1
                else:
                    cur.execute("UPDATE media_items SET unavailable = true, last_checked_at = now() WHERE id = %s", (mid,))
                    summary["unavailable"] += 1
            cur.execute("UPDATE collections c SET last_synced_at = now() WHERE source = 'youtube' AND kind = 'manual' AND last_synced_at < now() - %s", (REFRESH_SOON,))
            conn.commit()
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            summary["errors"].append(f"videos: {e}")
        summary["units"] = yt.units
    # III.E.4 hard limit: anything not refreshed within 30 days is deleted.
    cur.execute("DELETE FROM media_items WHERE source = 'youtube' AND last_checked_at < now() - %s RETURNING id", (HARD_LIMIT,))
    summary["deleted_stale"] = len(cur.fetchall())
    cur.execute(
        """UPDATE collections c SET item_count = (SELECT count(*) FROM collection_items ci WHERE ci.collection_id = c.id)
           WHERE source = 'youtube'"""
    )
    conn.commit()
    # SoundCloud: fresh oEmbed for sets/tracks synced > 25 days ago (no key needed).
    cur.execute("SELECT id, url FROM collections WHERE source = 'soundcloud' AND last_synced_at < now() - %s", (REFRESH_SOON,))
    for cid, url in cur.fetchall():
        try:
            o = _get(SC_OEMBED, {"format": "json", "url": url}, sc_http)
            cur.execute(
                "UPDATE collections SET title = coalesce(%s, title), owner_display = %s, artwork_url = %s, embed_html = coalesce(%s, embed_html), last_synced_at = now() WHERE id = %s",
                (o.get("title"), o.get("author_name"), o.get("thumbnail_url"), o.get("html"), cid),
            )
            cur.execute(
                """UPDATE media_items m SET title = coalesce(%s, m.title), artist_display = %s, artwork_url = %s, last_checked_at = now()
                   FROM collection_items ci WHERE ci.media_item_id = m.id AND ci.collection_id = %s""",
                (o.get("title"), o.get("author_name"), o.get("thumbnail_url"), cid),
            )
            conn.commit()
            summary["soundcloud"] += 1
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            summary["errors"].append(f"soundcloud {url}: {e}")
    return summary
