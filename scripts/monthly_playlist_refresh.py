"""Monthly 1st-of-month cron (06:00 UTC): refresh the slow-moving Top 100s + rolling #1.

v0.72: these playlists moved off the weekly refresh onto their own monthly cadence:
  - Top 100 this year   (updating, rank-tracked)
  - Top 100 all-time    (updating, rank-tracked)
  - My Monthly #1       (rolling chain — appends the just-completed month's #1)

Runs AFTER the daily 05:00 create-snapshots cron so the just-ended month is already
final in spotify_plays (and its Top 25 · Month snapshot exists) before My Monthly #1
picks up that month's #1. Sends a dedicated "monthly" digest email.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import time

from dotenv import load_dotenv
import psycopg

from lib.spotify import get_spotify_client
from lib.playlists import get_managed_playlists, update_managed_playlist, get_full_name
from lib.email_notify import EmailEventCollector, send_digest


def main() -> None:
    load_dotenv()
    print("[monthly] Getting Spotify client...", flush=True)
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]
    print(f"[monthly] Logged in as {user_id}.", flush=True)

    print("[monthly] Building playlist library cache...", flush=True)
    playlist_cache: dict[str, str] = {}
    offset = 0
    while True:
        page = sp.current_user_playlists(limit=50, offset=offset)
        items = page.get("items", []) or []
        for p in items:
            if p and p.get("name"):
                playlist_cache[p["name"]] = p["id"]
        if len(items) < 50:
            break
        offset += 50
    print(f"[monthly] Cached {len(playlist_cache)} existing playlists.", flush=True)

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    collector = EmailEventCollector()

    definitions = [
        d for d in get_managed_playlists(conn, sp)
        if d.kind != "snapshot" and d.cadence == "monthly"
    ]
    total = len(definitions)
    start = time.time()
    for i, definition in enumerate(definitions, start=1):
        full_name = get_full_name(definition)
        print(f"\n[{i}/{total}] {full_name}", flush=True)
        try:
            result = update_managed_playlist(
                sp, conn, user_id, definition, playlist_cache, collector=collector
            )
            print(f"    {result['track_count']} tracks → {result['action']}", flush=True)
        except Exception as e:
            print(f"    FAILED: {e}", flush=True)
            continue

    duration = time.time() - start
    print(f"\n=== Done. {total} monthly playlists processed in {duration:.1f}s. ===", flush=True)

    # Best-effort monthly digest: playlist ops already succeeded, so a mail failure must
    # not change the exit code.
    try:
        sent = send_digest(collector, conn, run_type="monthly")
        if sent:
            print(f"Sent monthly digest with {len(collector.events)} events.", flush=True)
        else:
            print("No events this run, skipped digest email.", flush=True)
    except Exception as e:
        print(f"WARNING: Failed to send monthly digest: {e}", file=sys.stderr)

    conn.close()


if __name__ == "__main__":
    main()
