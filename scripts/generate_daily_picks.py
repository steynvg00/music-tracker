"""Generate Rotor's daily pick candidates (v0.81, R1). DB only: no Spotify calls.

Nightly cron (scheduled-ingest.yml, 30 4 * * *): writes 5 candidates for today
(Europe/Amsterdam) unless they already exist. "Shuffle the deck" in the hub runs this
with --reseed through .github/workflows/daily-pick-reseed.yml, which appends 5 more.

  uv run python scripts/generate_daily_picks.py                 # today, skip if present
  uv run python scripts/generate_daily_picks.py --dry-run       # print, write nothing
  uv run python scripts/generate_daily_picks.py --reseed        # append ranks 6..10
  uv run python scripts/generate_daily_picks.py --date 2026-11-05 --force
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import os
from datetime import date

import psycopg
from dotenv import load_dotenv

from lib.daily_picks import format_duration, generate, today_local


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", type=date.fromisoformat, help="pick date (default: today in Europe/Amsterdam)")
    ap.add_argument("--reseed", action="store_true", help="append 5 new candidates to the day's deck")
    ap.add_argument("--force", action="store_true", help="regenerate a day that wasn't played or rotated yet")
    ap.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    args = ap.parse_args()

    day = args.date or today_local()
    print(f"[daily-picks] {day} (reseed={args.reseed}, force={args.force}, dry_run={args.dry_run})", flush=True)
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    try:
        result = generate(conn, day, reseed=args.reseed, force=args.force, dry_run=args.dry_run)
    finally:
        conn.close()

    if result.status == "exists":
        print(f"[daily-picks] {day} already has candidates. Nothing to do (use --reseed or --force).", flush=True)
        return 0
    if result.status == "empty":
        print("[daily-picks] ERROR: no candidate could be built (empty history or mirror?).",
              file=sys.stderr, flush=True)
        return 1
    for i, c in enumerate(result.deck):
        extra = (f"{len(c.track_uris)} tracks · {format_duration(c.duration_ms or 0)}"
                 if c.kind == "generated" else f"playlist {c.playlist_id} · score {c.score}")
        print(f"  #{result.start_rank + i} [{c.kind}{'/' + c.recipe if c.recipe else ''}] "
              f"{c.title} — {c.reason} ({extra})", flush=True)
    print(f"\n=== Done: {result.status}, {len(result.deck)} candidates"
          f"{' (dry run, nothing written)' if args.dry_run else ''}. ===", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
