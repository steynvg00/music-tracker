"""One-off backfill: populate the rolling "My Monthly #1" playlist with its full history.

v0.72: the rolling My Monthly #1 playlist holds the #1 track of every COMPLETED month,
oldest first (equivalent to the #1 of each Top 25 · Month snapshot). This script materialises
that whole chain in one shot — one track per completed month with plays (~112) — so the user
doesn't have to wait for the monthly cron to build it up one entry at a time.

The chain is recomputed from spotify_plays via the same query the recurring monthly refresh
uses (lib.playlists.rolling_monthly_number_one_playlist), so a real run and the first monthly
cron run are identical (full-chain replace, idempotent).

Flags:
    --dry-run   compute + preview (count, first 3, last 3) only; no Spotify writes.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import os

from dotenv import load_dotenv
import psycopg

from lib.playlists import (
    rolling_monthly_number_one_playlist,
    update_managed_playlist,
    get_full_name,
)
from lib.email_notify import _hydrate_playcounts


def _preview_line(uri: str, playcounts) -> str:
    name, artist, _plays = playcounts.get(uri, ("(unknown track)", "(unknown artist)", 0))
    return f"{name} — {artist}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill the rolling My Monthly #1 playlist.")
    parser.add_argument("--dry-run", action="store_true", default=False,
                        help="Preview only: no Spotify writes.")
    args = parser.parse_args()

    load_dotenv()
    conn = psycopg.connect(os.environ["DATABASE_URL"])

    definition = rolling_monthly_number_one_playlist(conn)[0]
    uris = definition.query_fn(conn)
    full_name = get_full_name(definition)

    playcounts = _hydrate_playcounts(conn, uris[:3] + uris[-3:])

    print(f"=== backfill My Monthly #1 rolling ({'DRY-RUN' if args.dry_run else 'LIVE'}) ===", flush=True)
    print(f"Would add {len(uris)} tracks to '{full_name}' in chronological order "
          "(one per completed month, oldest first).", flush=True)
    if uris:
        print("First 3 (oldest):", flush=True)
        for uri in uris[:3]:
            print(f"    {_preview_line(uri, playcounts)}", flush=True)
        print("Last 3 (newest):", flush=True)
        for uri in uris[-3:]:
            print(f"    {_preview_line(uri, playcounts)}", flush=True)

    if args.dry_run:
        print("Dry run — no Spotify writes.", flush=True)
        conn.close()
        return

    from lib.spotify import get_spotify_client
    sp = get_spotify_client()
    user_id = sp.current_user()["id"]

    print("Building playlist library cache...", flush=True)
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

    result = update_managed_playlist(sp, conn, user_id, definition, playlist_cache)
    print(f"Done: {result['track_count']} tracks → {result['action']} ('{result['name']}').", flush=True)
    conn.close()


if __name__ == "__main__":
    main()
