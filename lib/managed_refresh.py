"""Refresh ONE managed playlist on demand (v0.82, R2: "Refresh this playlist now").

Used by `scripts/update_managed_playlists.py --only <playlist_id>` and by the hub job
`refresh_managed` (scripts/run_hub_job.py).

Write safety, the Python twin of hub/src/lib/server/spotify/write-guard.ts:
  1. The playlist is read LIVE from Spotify: owner must be the signed-in user and the
     verbatim name must end with an Auto suffix (' · Auto 🤖🔄' or ' · Auto 🤖📸').
     Custom 🎧 and unmanaged playlists are refused before anything is written.
  2. The writes themselves go through lib/playlists.update_managed_playlist, i.e. the
     existing SAFETY CONTRACT: replace/add only on the id find_or_create_managed_playlist
     returns for a managed definition. A one-entry name→id cache pins that id to the
     requested playlist, and the result is checked against it.
"""

from __future__ import annotations

import lib.playlists as playlists
from lib.playlist_mirror import managed_kind
from lib.playlist_settings import request_force_refresh


class ReadOnlyPlaylist(Exception):
    def __init__(self, playlist_id: str, reason: str):
        super().__init__(f"Playlist {playlist_id} can't be refreshed by Rotor ({reason})")
        self.playlist_id = playlist_id
        self.reason = reason


REFRESHABLE = ("auto_updating", "auto_snapshot")


def assert_refreshable(sp, playlist_id: str, me: str) -> dict:
    """Live check at Spotify. Returns {'name', 'kind'} or raises ReadOnlyPlaylist."""
    pl = sp.playlist(playlist_id, fields="id,name,owner(id)") or {}
    if (pl.get("owner") or {}).get("id") != me:
        raise ReadOnlyPlaylist(playlist_id, "not_owned")
    name = pl.get("name") or ""
    kind = managed_kind(name)
    if kind not in REFRESHABLE:
        raise ReadOnlyPlaylist(playlist_id, "custom" if kind == "custom" else "no_managed_suffix")
    return {"name": name, "kind": kind}


def find_definition(conn, sp, name: str, kind: str):
    """The managed definition whose full (or legacy) name is `name`, any cadence."""
    if kind == "auto_snapshot":
        definitions = playlists.get_snapshot_definitions(conn)
    else:
        definitions = playlists.get_managed_playlists(conn, sp)
    for d in definitions:
        if playlists.get_full_name(d) == name or name in d.legacy_names:
            return d
    return None


def refresh_one(conn, sp, playlist_id: str, me: str | None = None) -> dict:
    """Rewrite one Auto playlist now. Snapshots are rebuilt (force refresh).

    Returns update_managed_playlist's result dict: name, playlist_id, track_count, action.
    """
    me = me or sp.current_user()["id"]
    info = assert_refreshable(sp, playlist_id, me)
    definition = find_definition(conn, sp, info["name"], info["kind"])
    if definition is None:
        raise LookupError(f"no managed definition produces '{info['name']}'")

    if info["kind"] == "auto_snapshot":
        # Snapshots are only rewritten when a force refresh is pending.
        request_force_refresh(conn, playlist_id, info["name"])

    # Order preferences and force-refresh flags must be read fresh for this call.
    playlists._playlist_settings_cache = None
    cache = {info["name"]: playlist_id}
    result = playlists.update_managed_playlist(sp, conn, me, definition, cache, collector=None)
    if result["playlist_id"] != playlist_id:
        raise RuntimeError(f"refresh resolved to {result['playlist_id']}, expected {playlist_id}")
    return result
