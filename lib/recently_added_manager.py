"""Maintenance rules for the user's manual "Recently Added Tracks" playlist.

Two rules run on the existing 30-min ingest cron:
  1. Purge: remove tracks added to the playlist more than 90 days ago
     (per Spotify's per-track added_at timestamp, NOT release_date/first_play).
  2. Auto-like: add tracks currently in the playlist that aren't yet in the
     user's Liked Songs.

This playlist is NOT a managed playlist (it is not created/refreshed from data
and is not registered in lib/playlists.py). It is a manually-curated playlist
with only these two maintenance rules applied on top.

Set MUSIC_TRACKER_DRY_RUN=1 to log what would happen without making any Spotify
writes — used for pre-deploy verification.
"""

import os
import sys
from datetime import datetime, timedelta, timezone

from lib.spotify import add_to_liked_songs_batch, check_liked_songs_batch

PLAYLIST_NAME = "Recently Added Tracks"
PURGE_AFTER_DAYS = 90  # 3 months
LIVE_LOGGING = True  # print [recently-added] prefix per action

# The playlist id never changes once found — cache it module-level so repeat
# runs within the same process don't re-paginate the user's playlists.
_cached_playlist_id: str | None = None


def _log(msg: str) -> None:
    if LIVE_LOGGING:
        print(f"[recently-added] {msg}", flush=True)


def _dry_run() -> bool:
    return os.environ.get("MUSIC_TRACKER_DRY_RUN") == "1"


def _find_playlist_id(sp) -> str | None:
    """Find the playlist id by exact (case-sensitive) name, with module caching."""
    global _cached_playlist_id
    if _cached_playlist_id is not None:
        return _cached_playlist_id

    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        items = page.get("items", []) or []
        for pl in items:
            if pl.get("name") == PLAYLIST_NAME:
                _cached_playlist_id = pl["id"]
                return _cached_playlist_id
        if not page.get("next"):
            break
        offset += 50
    return None


def _fetch_playlist_tracks(sp, playlist_id: str) -> list[dict]:
    """Fetch current playlist tracks with their added_at timestamps.

    Returns a list of dicts: {track_id, uri, name, artists, added_at (datetime)}.
    Skips local tracks and null tracks.
    """
    tracks: list[dict] = []
    offset = 0
    while True:
        page = sp.playlist_items(
            playlist_id,
            limit=100,
            offset=offset,
            fields="items(added_at,is_local,track(id,uri,name,is_local,artists(name))),next",
        )
        items = page.get("items", []) or []
        for it in items:
            if it.get("is_local"):
                continue
            track = it.get("track") or {}
            if not track or track.get("is_local"):
                continue
            track_id = track.get("id")
            uri = track.get("uri")
            if not track_id or not uri:
                continue
            added_at = _parse_added_at(it.get("added_at"))
            tracks.append(
                {
                    "track_id": track_id,
                    "uri": uri,
                    "name": track.get("name") or "",
                    "artists": ", ".join(
                        a.get("name", "") for a in (track.get("artists") or [])
                    ),
                    "added_at": added_at,
                }
            )
        if not page.get("next"):
            break
        offset += 100
    return tracks


def _parse_added_at(value: str | None) -> datetime | None:
    """Parse Spotify's added_at ISO-8601 timestamp into a tz-aware datetime."""
    if not value:
        return None
    try:
        # Spotify uses e.g. "2024-01-15T12:34:56Z".
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def manage_recently_added_tracks(sp, conn) -> dict:
    """Run the two maintenance rules on the Recently Added Tracks playlist.

    1. Purge: remove tracks where added_at < now() - 90 days
    2. Auto-like: add tracks currently in the playlist that aren't in Liked Songs

    Returns a summary dict. Non-fatal: individual API errors are logged but the
    function completes. Fully silent (playlist_found=False) if the playlist is
    not found (user renamed or deleted it).
    """
    summary = {
        "playlist_found": False,
        "total_tracks_in_playlist": 0,
        "purged_count": 0,
        "liked_added_count": 0,
        "errors": [],
    }

    playlist_id = _find_playlist_id(sp)
    if not playlist_id:
        _log(
            f"Playlist '{PLAYLIST_NAME}' not found in user's playlists — skipping."
        )
        return summary

    summary["playlist_found"] = True

    tracks = _fetch_playlist_tracks(sp, playlist_id)
    summary["total_tracks_in_playlist"] = len(tracks)

    dry = _dry_run()
    if dry:
        _log("DRY RUN — no Spotify writes will be made.")

    # --- Purge step (first, so we don't like tracks we're about to remove) ---
    cutoff = datetime.now(timezone.utc) - timedelta(days=PURGE_AFTER_DAYS)
    to_purge = [
        t for t in tracks if t["added_at"] is not None and t["added_at"] < cutoff
    ]
    # Everything else stays — including tracks with an unparseable added_at, which
    # we keep rather than risk purging on missing data.
    remaining = [
        t for t in tracks if t["added_at"] is None or t["added_at"] >= cutoff
    ]

    for t in to_purge:
        days_ago = (datetime.now(timezone.utc) - t["added_at"]).days
        added_iso = t["added_at"].isoformat()
        prefix = "WOULD purge" if dry else "Purged"
        _log(
            f"{prefix}: {t['name']} — {t['artists']} "
            f"(added {added_iso}, {days_ago} days ago)"
        )

    if to_purge and not dry:
        purge_uris = [t["uri"] for t in to_purge]
        for i in range(0, len(purge_uris), 100):
            batch = purge_uris[i : i + 100]
            try:
                sp.playlist_remove_all_occurrences_of_items(playlist_id, batch)
            except Exception as e:
                msg = f"purge batch at offset {i} failed: {e}"
                summary["errors"].append(msg)
                print(f"WARNING: [recently-added] {msg}", file=sys.stderr)

    # purged_count reflects what was (or would be) removed.
    summary["purged_count"] = len(to_purge)

    # --- Auto-like step (on the tracks remaining after purge) ---
    remaining_ids = [t["track_id"] for t in remaining]
    id_to_track = {t["track_id"]: t for t in remaining}
    if remaining_ids:
        try:
            contains = check_liked_songs_batch(sp, remaining_ids)
        except Exception as e:
            msg = f"liked-songs contains check failed: {e}"
            summary["errors"].append(msg)
            print(f"WARNING: [recently-added] {msg}", file=sys.stderr)
            contains = {}

        missing_ids = [
            tid for tid in remaining_ids if contains.get(tid) is False
        ]

        for tid in missing_ids:
            t = id_to_track[tid]
            prefix = "WOULD auto-like" if dry else "Auto-liked"
            _log(f"{prefix}: {t['name']} — {t['artists']}")

        if missing_ids and not dry:
            try:
                summary["liked_added_count"] = add_to_liked_songs_batch(
                    sp, missing_ids
                )
            except Exception as e:
                msg = f"auto-like add failed: {e}"
                summary["errors"].append(msg)
                print(f"WARNING: [recently-added] {msg}", file=sys.stderr)
        elif missing_ids and dry:
            # In dry-run, report the count that WOULD be added.
            summary["liked_added_count"] = len(missing_ids)

    return summary
