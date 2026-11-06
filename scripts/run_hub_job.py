"""Run Rotor hub jobs (v0.82, R2). Invoked by .github/workflows/hub-jobs.yml.

  uv run python scripts/run_hub_job.py --job-id <uuid>   # one job (workflow_dispatch from the hub)
  uv run python scripts/run_hub_job.py --daily           # daily run (schedule)

The job id can also come from the JOB_ID env var (the workflow passes it that way, so
the input never reaches a shell command line). See lib/hub_jobs.py for the lifecycle.
Exit code: 0 when the job finished (done, or skipped because it wasn't queued), 1 when
it failed — the hub shows the error from the row either way.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import os

import psycopg
from dotenv import load_dotenv

from lib import hub_jobs


def _spotify_factory():
    cache = {}

    def get():
        if "sp" not in cache:
            from lib.spotify import get_spotify_client

            cache["sp"] = get_spotify_client()
        return cache["sp"]

    return get


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--job-id", help="hub_jobs.id to run (default: $JOB_ID)")
    g.add_argument("--daily", action="store_true", help="daily notifications, stale sweep, snapshot rebuilds")
    args = ap.parse_args()

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    try:
        if args.daily:
            summary = hub_jobs.run_daily(conn, sp_factory=_spotify_factory())
            print(f"\n=== Daily run: {summary} ===", flush=True)
            return 1 if summary["errors"] else 0
        job_id = (args.job_id or os.environ.get("JOB_ID") or "").strip()
        if not hub_jobs.is_job_id(job_id):
            print(f"[hub-job] ERROR: not a job id: {job_id!r}", file=sys.stderr, flush=True)
            return 2
        status = hub_jobs.run_job(conn, job_id, sp_factory=_spotify_factory(), run_url=os.environ.get("GITHUB_RUN_URL"))
        return 1 if status == "failed" else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
