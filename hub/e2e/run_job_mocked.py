"""E2E stand-in for .github/workflows/hub-jobs.yml: runs the REAL lib/hub_jobs code against the
throwaway database, with Spotify pointed at the local mock and Web Push recorded to a file.

  JOB_ID=<uuid> uv run python hub/e2e/run_job_mocked.py      # one job (what a dispatch does)
  uv run python hub/e2e/run_job_mocked.py --daily            # the daily schedule

Refuses to run unless DATABASE_URL points at localhost: this must never touch a real DB.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402
import spotipy  # noqa: E402

from lib import hub_jobs, web_push  # noqa: E402

DB = os.environ.get("DATABASE_URL", "")
if not any(h in DB for h in ("@localhost", "@127.0.0.1", "host=/")):
    sys.exit(f"refusing: DATABASE_URL is not local ({DB.split('@')[-1][:40]!r})")
PREFIX = os.environ["E2E_SPOTIFY_PREFIX"]
PUSH_LOG = os.environ.get("E2E_PUSH_LOG")
os.environ.setdefault("VAPID_PRIVATE_KEY", "e2e-not-a-real-key")
os.environ.setdefault("VAPID_SUBJECT", "mailto:e2e@example.invalid")


def sp_factory():
    sp = spotipy.Spotify(auth="e2e-token", retries=0, status_retries=0)
    sp.prefix = PREFIX
    return sp


def fake_webpush(subscription_info, data, vapid_private_key, vapid_claims, ttl, timeout):
    if PUSH_LOG:
        with open(PUSH_LOG, "a") as f:
            f.write(json.dumps({"endpoint": subscription_info["endpoint"], "data": json.loads(data)}) + "\n")


def push(conn, **kw):
    return web_push.send(conn, _webpush=fake_webpush, **kw)


def main() -> int:
    conn = psycopg.connect(DB)
    try:
        if "--daily" in sys.argv:
            summary = hub_jobs.run_daily(conn, sp_factory=sp_factory, push=push)
            print(f"[e2e-daily] {summary}", flush=True)
            return 1 if summary["errors"] else 0
        status = hub_jobs.run_job(conn, os.environ["JOB_ID"], sp_factory=sp_factory, push=push, run_url="http://e2e/run/1")
        return 1 if status == "failed" else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
