"""Mirror the user's Spotify playlists into spotify_playlists / spotify_playlist_items (v0.81, R1).

Nightly cron (scheduled-ingest.yml, 15 4 * * *). Read-only towards Spotify. Items are
only re-fetched for playlists whose snapshot_id changed since the last run.

  uv run python scripts/sync_playlist_mirror.py
  uv run python scripts/sync_playlist_mirror.py --all-items   # also items of auto-updating playlists
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import os

import psycopg
from dotenv import load_dotenv

from lib.playlist_mirror import sync_mirror
from lib.spotify import get_spotify_client


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all-items", action="store_true", help="mirror items of every readable playlist")
    args = ap.parse_args()

    print("[mirror] Getting Spotify client...", flush=True)
    sp = get_spotify_client()
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    try:
        r = sync_mirror(conn, sp, all_items=args.all_items)
        # v0.82: rule catalog + playlist→category tags for the hub's Rules view. DB only;
        # a failure here must not fail the mirror.
        try:
            from lib.rules_catalog import export_rules_catalog

            print(f"[mirror] Rules catalog: {export_rules_catalog(conn)}", flush=True)
        except Exception as e:
            conn.rollback()
            print(f"[mirror] WARNING: rules catalog export failed: {e}", file=sys.stderr, flush=True)
    finally:
        conn.close()
    print(
        f"\n=== Done. Listed {r.listed}, upserted {r.upserted}, marked removed {r.removed}"
        f"{' (skipped: suspicious listing)' if r.removal_skipped else ''}, "
        f"items synced for {r.items_synced}, item failures {len(r.items_failed)}. ===",
        flush=True,
    )
    return 1 if r.items_failed and not r.items_synced else 0


if __name__ == "__main__":
    sys.exit(main())
