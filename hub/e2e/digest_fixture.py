"""E2E (R8): one weekly digest through the REAL send_digest into the throwaway DB.

Mail is MUSIC_TRACKER_EMAIL_DRY_RUN=1 (printed, never sent). Also writes three rank snapshots for
the seeded "Top 30 last 30 days" (two weeks ago, last week, now), so the stored digest has arrows
and last week can be rebuilt from rank history. Prints the fixture as JSON for the spec.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

url = os.environ.get("E2E_DB") or ""
if "@127.0.0.1:" not in url and "@localhost:" not in url:
    raise SystemExit("digest_fixture: E2E_DB must be the local throwaway database")
os.environ["DATABASE_URL"] = url
os.environ["MUSIC_TRACKER_EMAIL_DRY_RUN"] = "1"
for k in ("GMAIL_USER", "GMAIL_APP_PASSWORD"):
    os.environ.pop(k, None)

import psycopg  # noqa: E402

from lib.email_notify import EmailEventCollector, EventType, PlaylistEvent, send_digest  # noqa: E402

with psycopg.connect(url) as conn:
    pid, top_name = conn.execute(
        "SELECT playlist_id, name FROM spotify_playlists WHERE name LIKE 'Top 30 last 30 days%' LIMIT 1").fetchone()
    other_id, other_name = conn.execute(
        "SELECT playlist_id, name FROM spotify_playlists WHERE name LIKE 'Forgotten favorites%' LIMIT 1").fetchone()
    uris = [r[0] for r in conn.execute(
        "SELECT track_uri FROM hub.mv_track_stats ORDER BY plays DESC, track_uri LIMIT 5").fetchall()]
    a, b, c, d, e = uris
    conn.execute("DELETE FROM playlist_rank_history WHERE playlist_id = %s", (pid,))
    conn.execute("DELETE FROM digest_runs")
    rows = [
        (a, "14 days", 1), (b, "14 days", 2), (c, "14 days", 3),
        (c, "7 days", 1), (a, "7 days", 2), (b, "7 days", 3),     # last week: c rose to #1
        (a, "0 days", 1), (b, "0 days", 2), (c, "0 days", 3), (d, "0 days", 4),
    ]
    for uri, ago, rank in rows:
        conn.execute(
            "INSERT INTO playlist_rank_history (playlist_id, track_uri, snapshot_at, rank) "
            "VALUES (%s, %s, now() - %s::interval, %s)", (pid, uri, ago, rank))
    conn.commit()

    col = EmailEventCollector()
    col.add_event(PlaylistEvent(EventType.TRACKS_ADDED, top_name, "updating", True, playlist_id=pid,
                                ranked_tracks=[{"uri": u, "rank": i + 1, "plays_in_context": 20 - i} for i, u in enumerate([a, b, c, d])]))
    col.add_event(PlaylistEvent(EventType.TRACKS_ADDED, other_name, "updating", False, playlist_id=other_id, tracks=[e]))
    col.add_event(PlaylistEvent(EventType.TRACKS_REMOVED, other_name, "updating", False, playlist_id=other_id, tracks=[c]))
    col.add_event(PlaylistEvent(EventType.PLAYLIST_CREATED, "E2E Brand new · Auto 🤖🔄", "updating", False,
                                tracks=[a, b], extra={"description": "A list that didn't exist last week"}))
    # A new list's tracks arrive as their own TRACKS_ADDED event, as in lib/playlists.py.
    col.add_event(PlaylistEvent(EventType.TRACKS_ADDED, "E2E Brand new · Auto 🤖🔄", "updating", False, tracks=[a, b]))
    sent = send_digest(col, conn, run_type="weekly")
    print("FIXTURE " + json.dumps({"sent": sent, "playlistId": pid, "top": top_name, "other": other_name, "uris": uris}), flush=True)
