"""Snapshot-creation notification (v0.65 as a mail; a Web Push since v0.89, R9).

Sent by the daily create-snapshots cron the moment a period snapshot playlist is created:
"Snapshot ready: <period>", with the #1 track, linking to the playlist in Rotor. Never fatal:
a push problem never breaks the cron (lib/notify.py).
"""

from __future__ import annotations

from typing import Literal

from lib import notify


def build_and_send_snapshot_notification(
    conn,
    kind: Literal["month", "season", "year", "alltime", "decade"],
    display_name: str,
    playlist_name: str,
    ranked_tracks: list[dict],
    playlist_id: str | None = None,
) -> bool:
    """Push 'Snapshot ready' (kind 'snapshot'). Returns True if a device got it."""
    if not ranked_tracks:
        print(f"[snapshot-notify] No tracks for {display_name}; nothing to send.", flush=True)
        return False
    top = ranked_tracks[0]
    body = (f"#1 of {len(ranked_tracks)}: {top.get('track_name') or top.get('track_uri')} — "
            f"{top.get('artist_display') or ''} ({top.get('plays_in_period', '?')} plays)").rstrip(" —")
    url = f"/playlist/{playlist_id}" if playlist_id else "/library"
    n = notify.notify(conn, "snapshot", title=f"Snapshot ready: {display_name}", body=body, url=url,
                      dedupe_key=f"snapshot:{kind}:{playlist_name}")
    return n > 0
