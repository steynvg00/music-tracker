"""Playlist mirror (v0.81, R1): copy the user's Spotify playlists into the DB.

Tables spotify_playlists / spotify_playlist_items (migration 0020). Run nightly by
scripts/sync_playlist_mirror.py with the cron app's token; the Rotor hub refreshes the
metadata on demand (hub/src/lib/server/spotify/mirror.ts) with its own token.

Read-only towards Spotify: this module only calls GET /me, GET /me/playlists and
GET /playlists/{id}/items. It never writes to Spotify.

managed_kind is informational. The hub's write guard re-checks the live name and
owner at Spotify before every write; nothing trusts this column for permission.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field

from lib.playlists import SNAPSHOT_NAME_SUFFIX, UPDATING_NAME_SUFFIX
from lib.temporary_playlists import CUSTOM_NAME_SUFFIX

# Suffix → managed_kind. Must match MANAGED_SUFFIXES in
# hub/src/lib/shared/managed.ts; both are tested against tests/fixtures/managed_names.json.
MANAGED_SUFFIXES: dict[str, str] = {
    UPDATING_NAME_SUFFIX: "auto_updating",
    SNAPSHOT_NAME_SUFFIX: "auto_snapshot",
    CUSTOM_NAME_SUFFIX: "custom",
}

MISSED_NEW_PREFIX = "Missed new tracks"
_PAGE_SLEEP_S = 0.15
# Refuse to soft-delete when Spotify suddenly lists far fewer playlists than we have
# (API hiccup, wrong account): better a stale mirror than a wiped one.
_MIN_LISTED_FRACTION = 0.5


def managed_kind(name: str) -> str | None:
    """Exact suffix match on the verbatim name, fail-closed: anything else is unmanaged."""
    for suffix, kind in MANAGED_SUFFIXES.items():
        if name.endswith(suffix) and len(name) > len(suffix):
            return kind
    return None


def parse_playlist(pl: dict, me_id: str) -> dict:
    """One /me/playlists entry → a spotify_playlists row (without timestamps)."""
    owner = pl.get("owner") or {}
    owner_id = owner.get("id") or ""
    name = pl.get("name") or ""
    is_owned = owner_id == me_id
    # Feb 2026 Web API renamed the playlist's `tracks` object to `items`; accept both.
    counts = pl.get("items") if isinstance(pl.get("items"), dict) else pl.get("tracks")
    images = pl.get("images") or []
    return {
        "playlist_id": pl["id"],
        "name": name,
        "owner_id": owner_id,
        "owner_name": owner.get("display_name"),
        "is_owned": is_owned,
        "is_collab": bool(pl.get("collaborative")),
        "is_public": pl.get("public"),
        "managed_kind": managed_kind(name) if is_owned else None,
        "snapshot_id": pl.get("snapshot_id"),
        "track_count": (counts or {}).get("total"),
        "image_url": images[0].get("url") if images else None,
    }


def wants_items(row: dict, all_items: bool = False) -> bool:
    """Which playlists get their items mirrored.

    Spotify only returns items for playlists you own or collaborate on. Of those, by
    default only what the daily pick uses: unmanaged playlists and snapshots (rotation
    coverage), custom playlists, and the two Missed new tracks playlists (Fresh heat).
    The ~180 auto-updating playlists are skipped: they change weekly and nothing in R1
    reads their items. --all-items mirrors everything readable.
    """
    if not (row["is_owned"] or row["is_collab"]):
        return False
    if all_items:
        return True
    kind = row["managed_kind"]
    if kind in (None, "auto_snapshot", "custom"):
        return True
    return kind == "auto_updating" and row["name"].startswith(MISSED_NEW_PREFIX)


def parse_item(entry: dict) -> dict | None:
    # Feb 2026 Web API renamed an entry's `track` to `item`; accept both.
    obj = entry.get("track") or entry.get("item") or {}
    uri = obj.get("uri")
    if not uri:
        return None
    artists = obj.get("artists") or []
    return {
        "track_uri": uri,
        "track_name": obj.get("name"),
        "artist_name": ", ".join(a.get("name", "") for a in artists if a.get("name")) or None,
        "duration_ms": obj.get("duration_ms"),
        "added_at": entry.get("added_at"),
    }


def fetch_all_playlists(sp) -> list[dict]:
    out: list[dict] = []
    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        out.extend(p for p in (page.get("items") or []) if p and p.get("id"))
        if not page.get("next"):
            return out
        offset += 50
        time.sleep(_PAGE_SLEEP_S)


def fetch_items(sp, playlist_id: str) -> list[dict]:
    items: list[dict] = []
    offset = 0
    while True:
        page = sp.playlist_items(
            playlist_id,
            limit=100,
            offset=offset,
            fields="items(added_at,track(uri,name,duration_ms,artists(name))),next",
        )
        for entry in page.get("items") or []:
            parsed = parse_item(entry or {})
            if parsed:
                items.append(parsed)
        if not page.get("next"):
            return items
        offset += 100
        time.sleep(_PAGE_SLEEP_S)


@dataclass
class SyncResult:
    listed: int = 0
    upserted: int = 0
    removed: int = 0
    removal_skipped: bool = False
    items_synced: int = 0
    items_failed: list[str] = field(default_factory=list)


_UPSERT_SQL = """
INSERT INTO spotify_playlists (
    playlist_id, name, owner_id, owner_name, is_owned, is_collab, is_public,
    managed_kind, snapshot_id, track_count, image_url,
    first_seen_at, last_seen_at, removed_at, synced_by
) VALUES (
    %(playlist_id)s, %(name)s, %(owner_id)s, %(owner_name)s, %(is_owned)s, %(is_collab)s, %(is_public)s,
    %(managed_kind)s, %(snapshot_id)s, %(track_count)s, %(image_url)s,
    %(run_at)s, %(run_at)s, NULL, 'python'
)
ON CONFLICT (playlist_id) DO UPDATE SET
    name         = EXCLUDED.name,
    owner_id     = EXCLUDED.owner_id,
    owner_name   = EXCLUDED.owner_name,
    is_owned     = EXCLUDED.is_owned,
    is_collab    = EXCLUDED.is_collab,
    is_public    = EXCLUDED.is_public,
    managed_kind = EXCLUDED.managed_kind,
    snapshot_id  = EXCLUDED.snapshot_id,
    track_count  = EXCLUDED.track_count,
    image_url    = EXCLUDED.image_url,
    last_seen_at = EXCLUDED.last_seen_at,
    removed_at   = NULL,
    synced_by    = 'python'
"""


def sync_mirror(conn, sp, *, all_items: bool = False, sleep_s: float = 0.2) -> SyncResult:
    result = SyncResult()
    me_id = sp.current_user()["id"]
    rows = [parse_playlist(p, me_id) for p in fetch_all_playlists(sp)]
    result.listed = len(rows)

    cur = conn.cursor()
    cur.execute("SELECT now()")
    run_at = cur.fetchone()[0]
    cur.execute(
        "SELECT playlist_id, items_snapshot_id FROM spotify_playlists WHERE removed_at IS NULL"
    )
    previous = dict(cur.fetchall())

    for row in rows:
        cur.execute(_UPSERT_SQL, {**row, "run_at": run_at})
    result.upserted = len(rows)

    # Soft-delete what Spotify no longer lists. Collaborative playlists are left to the
    # hub's on-demand sync: the cron token may lack playlist-read-collaborative, and then
    # /me/playlists omits them.
    if previous and len(rows) < _MIN_LISTED_FRACTION * len(previous):
        result.removal_skipped = True
        print(
            f"[mirror] WARNING: Spotify listed {len(rows)} playlists, the mirror has "
            f"{len(previous)}. Not marking anything removed this run.",
            file=sys.stderr,
            flush=True,
        )
    else:
        cur.execute(
            """
            UPDATE spotify_playlists SET removed_at = %s
             WHERE removed_at IS NULL AND last_seen_at < %s AND NOT is_collab
            """,
            (run_at, run_at),
        )
        result.removed = cur.rowcount or 0
    conn.commit()

    for row in rows:
        if not wants_items(row, all_items):
            continue
        if not all_items and row["snapshot_id"] and previous.get(row["playlist_id"]) == row["snapshot_id"]:
            continue  # unchanged since the last items sync
        try:
            items = fetch_items(sp, row["playlist_id"])
        except Exception as e:  # 403/404 on one playlist must not stop the run
            result.items_failed.append(row["playlist_id"])
            print(f"[mirror] WARNING: items of '{row['name']}' failed: {e}", file=sys.stderr, flush=True)
            continue
        cur.execute("DELETE FROM spotify_playlist_items WHERE playlist_id = %s", (row["playlist_id"],))
        cur.executemany(
            """
            INSERT INTO spotify_playlist_items
                (playlist_id, position, track_uri, track_name, artist_name, duration_ms, added_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (row["playlist_id"], pos, it["track_uri"], it["track_name"], it["artist_name"],
                 it["duration_ms"], it["added_at"])
                for pos, it in enumerate(items)
            ],
        )
        cur.execute(
            """
            UPDATE spotify_playlists SET items_snapshot_id = %s, items_synced_at = now()
             WHERE playlist_id = %s
            """,
            (row["snapshot_id"], row["playlist_id"]),
        )
        conn.commit()
        result.items_synced += 1
        if sleep_s:
            time.sleep(sleep_s)
    return result
