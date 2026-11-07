"""Hub job runner (v0.82, R2). The Python half of the hub's job system.

Lifecycle of a hub_jobs row (migration 0022):

    hub inserts            queued   (dedupe_key keeps one active job per key)
    hub dispatches hub-jobs.yml with job_id
    claim()                queued → running   (atomic; a second dispatch finds nothing to do)
    handler runs
    finish() / fail()      running → done | failed   (+ "job finished" Web Push)
    hub "Retry"            failed → queued and dispatches again (attempts counts claims)
    sweep_stale()          queued > 15 min or running > 30 min → failed

Kinds: reseed_daily_pick ("Shuffle the deck"), refresh_managed ("Refresh this playlist
now" / snapshot rebuild), push_test ("Send a test notification"), wrapped_build (v0.86:
"Build" a past year in Stats › Wrapped; DB only).

The daily run (run_daily) sweeps stale jobs, rebuilds snapshots with a pending
force-refresh request, sends "Today's pick is ready" and token-expiry notifications,
re-exports the rules catalog, (v0.84) refreshes Elsewhere metadata within 30 days and
(v0.86) freezes last year's Rotor Wrapped when it is missing (so on 1 January).
"""

from __future__ import annotations

import json
import re
import sys
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Callable

from lib import daily_picks, web_push
from lib.playlist_mirror import managed_kind

KINDS = ("reseed_daily_pick", "refresh_managed", "push_test", "wrapped_build")
STALE_QUEUED = timedelta(minutes=15)
STALE_RUNNING = timedelta(minutes=30)
TOKEN_NOTICE_DAYS = (14, 3)
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_PLAYLIST_ID = re.compile(r"^[A-Za-z0-9]{22}$")


@dataclass(frozen=True)
class Job:
    id: str
    kind: str
    payload: dict
    attempts: int
    dedupe_key: str | None


def is_job_id(v: str | None) -> bool:
    return bool(v and _UUID.match(v))


def claim(conn, job_id: str, run_url: str | None = None) -> Job | None:
    """queued → running, atomically. None when the job isn't queued (already claimed,
    finished, or unknown): a duplicate dispatch then does nothing."""
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE hub_jobs
           SET status = 'running', started_at = now(), finished_at = NULL, error = NULL,
               attempts = attempts + 1, run_url = COALESCE(%s, run_url)
         WHERE id = %s AND status = 'queued'
     RETURNING id, kind, payload, attempts, dedupe_key
        """,
        (run_url, job_id),
    )
    row = cur.fetchone()
    conn.commit()
    if row is None:
        return None
    return Job(id=str(row[0]), kind=row[1], payload=row[2] or {}, attempts=row[3], dedupe_key=row[4])


def finish(conn, job_id: str, result: dict) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE hub_jobs SET status = 'done', finished_at = now(), result = %s::jsonb, error = NULL
         WHERE id = %s AND status = 'running'
        """,
        (json.dumps(result, default=str), job_id),
    )
    conn.commit()


def fail(conn, job_id: str, error: str) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE hub_jobs SET status = 'failed', finished_at = now(), error = %s
         WHERE id = %s AND status IN ('queued', 'running')
        """,
        (error[:500], job_id),
    )
    conn.commit()


def sweep_stale(conn) -> int:
    """Jobs nobody picked up (dispatch lost) or that died mid-run → failed (retryable)."""
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE hub_jobs
           SET status = 'failed', finished_at = now(),
               error = CASE WHEN status = 'queued' THEN 'stale: no runner picked the job up'
                            ELSE 'stale: the run stopped without reporting back' END
         WHERE (status = 'queued' AND requested_at < now() - %s)
            OR (status = 'running' AND started_at < now() - %s)
        RETURNING id
        """,
        (STALE_QUEUED, STALE_RUNNING),
    )
    n = len(cur.fetchall())
    conn.commit()
    return n


# ── Handlers ────────────────────────────────────────────────────────────────

class JobError(Exception):
    """A job failed for a reason worth showing as-is in the hub."""


def _reseed(conn, payload: dict, ctx: dict) -> dict:
    try:
        day = date.fromisoformat(str(payload.get("date")))
    except ValueError:
        raise JobError("payload.date must be YYYY-MM-DD") from None
    r = daily_picks.generate(conn, day, reseed=True)
    return {"status": r.status, "added": len(r.deck), "start_rank": r.start_rank if r.deck else None}


def _refresh(conn, payload: dict, ctx: dict) -> dict:
    from lib.managed_refresh import refresh_one

    playlist_id = str(payload.get("playlist_id") or "")
    if not _PLAYLIST_ID.match(playlist_id):
        raise JobError("payload.playlist_id is not a Spotify playlist id")
    r = refresh_one(conn, ctx["sp"](), playlist_id)
    return {"playlist_id": r["playlist_id"], "name": r["name"], "track_count": r["track_count"], "action": r["action"]}


def _push_test(conn, payload: dict, ctx: dict) -> dict:
    if not web_push.configured():
        raise JobError("VAPID_PRIVATE_KEY / VAPID_SUBJECT are not set in the GitHub secrets")
    n = ctx["push"](conn, kind="test", title="Rotor", body="Notifications work on this device.", url="/settings")
    return {"delivered": n}


def _wrapped_build(conn, payload: dict, ctx: dict) -> dict:
    from lib import wrapped

    try:
        year = wrapped.valid_year(payload.get("year"), daily_picks.today_local())
    except wrapped.WrappedError as e:
        raise JobError(str(e)) from None
    return wrapped.freeze(conn, year, "job")


HANDLERS: dict[str, Callable[[object, dict, dict], dict]] = {
    "reseed_daily_pick": _reseed,
    "refresh_managed": _refresh,
    "push_test": _push_test,
    "wrapped_build": _wrapped_build,
}


def _finished_message(job: Job, ok: bool, result: dict | None, error: str | None) -> tuple[str, str] | None:
    """(body, url) for the 'job finished' notification, or None for kinds that don't notify."""
    if job.kind == "push_test":
        return None
    if not ok:
        return (f"A Rotor job failed: {error}", "/settings")
    if job.kind == "wrapped_build":
        year = (result or {}).get("year")
        return (f"Your Rotor Wrapped {year} is ready", f"/wrapped/{year}")
    if job.kind == "reseed_daily_pick":
        added = (result or {}).get("added", 0)
        return ((f"{added} fresh picks are ready" if added else "No new picks could be mixed today"), "/home")
    return (f"{(result or {}).get('name', 'Playlist')} refreshed · {(result or {}).get('track_count', 0)} tracks",
            f"/playlist/{(result or {}).get('playlist_id', '')}")


def run_job(conn, job_id: str, *, sp_factory: Callable, push=web_push.send, run_url: str | None = None) -> str:
    """Claim + run one job. Returns 'done' | 'failed' | 'skipped'."""
    job = claim(conn, job_id, run_url)
    if job is None:
        print(f"[hub-job] {job_id} is not queued (already run, running or unknown); nothing to do.", flush=True)
        return "skipped"
    print(f"[hub-job] {job.id} {job.kind} attempt {job.attempts} payload={job.payload}", flush=True)
    handler = HANDLERS.get(job.kind)
    ctx = {"sp": sp_factory, "push": push}
    try:
        if handler is None:
            raise JobError(f"unknown job kind {job.kind!r}")
        result = handler(conn, job.payload, ctx)
    except Exception as e:  # every failure lands on the row; nothing is retried silently
        conn.rollback()
        error = str(e) if isinstance(e, JobError) else f"{type(e).__name__}: {e}"
        traceback.print_exc()
        fail(conn, job.id, error)
        status, result = "failed", None
    else:
        finish(conn, job.id, result)
        status, error = "done", None
    msg = _finished_message(job, status == "done", result, error)
    if msg:
        try:
            push(conn, kind="job", title="Rotor", body=msg[0], url=msg[1], tag=f"job-{job.id}")
        except Exception as e:  # a notification problem never changes the job's outcome
            conn.rollback()
            print(f"[hub-job] WARNING: job-finished notification failed: {e}", file=sys.stderr, flush=True)
    print(f"[hub-job] {job.id} → {status}" + (f": {error}" if error else ""), flush=True)
    return status


# ── Daily run ───────────────────────────────────────────────────────────────

def pending_snapshot_rebuilds(conn) -> list[tuple[str, str]]:
    """(playlist_id, name) of snapshots whose force refresh was requested and not yet done.

    Since v0.65 no cron rewrites snapshots, so without this a Streamlit/Rotor rebuild
    request would wait forever.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT playlist_id, playlist_name FROM playlist_settings
         WHERE force_refresh_requested_at IS NOT NULL
           AND (force_refresh_completed_at IS NULL OR force_refresh_requested_at > force_refresh_completed_at)
        """
    )
    return [(pid, name) for pid, name in cur.fetchall() if managed_kind(name or "") == "auto_snapshot"]


def token_notices(conn, today: date) -> list[dict]:
    """Expiry warnings at ≤ 14 and ≤ 3 days left, once per authorization."""
    cur = conn.cursor()
    cur.execute("SELECT client, authorized_at, last_error FROM hub_oauth_tokens")
    out = []
    for client, authorized_at, last_error in cur.fetchall():
        expires = _add_months(authorized_at, 6).date()
        days = (expires - today).days
        who = "Rotor's Spotify sign-in" if client == "hub" else "The crons' Spotify token"
        if last_error == "invalid_grant":
            out.append({"key": f"token:{client}:{expires}:dead", "body": f"{who} stopped working. Reconnect in Settings."})
            continue
        for threshold in sorted(TOKEN_NOTICE_DAYS):  # tightest first: at 2 days left, send the 3-day one
            if days <= threshold:
                out.append({"key": f"token:{client}:{expires}:{threshold}",
                            "body": f"{who} expires in {max(days, 0)} days. Reconnect in Settings."})
                break
    return out


def _add_months(dt: datetime, months: int) -> datetime:
    """Same rule as the hub's expiresAt(): calendar months, day clamped."""
    import calendar

    m = dt.month - 1 + months
    y = dt.year + m // 12
    m = m % 12 + 1
    d = min(dt.day, calendar.monthrange(y, m)[1])
    return dt.replace(year=y, month=m, day=d)


def run_daily(conn, *, sp_factory: Callable, push=web_push.send, today: date | None = None) -> dict:
    """Returns a summary; 'errors' lists the steps that failed."""
    from lib.managed_refresh import refresh_one
    from lib.rules_catalog import export_rules_catalog

    today = today or daily_picks.today_local()
    summary: dict = {"errors": []}

    def step(name, fn):
        try:
            summary[name] = fn()
        except Exception as e:
            conn.rollback()
            traceback.print_exc()
            summary["errors"].append(f"{name}: {type(e).__name__}: {e}")

    step("stale_jobs", lambda: sweep_stale(conn))

    def rebuilds():
        done = []
        for pid, name in pending_snapshot_rebuilds(conn):
            r = refresh_one(conn, sp_factory(), pid)
            done.append(r["name"])
        return done

    step("snapshot_rebuilds", rebuilds)

    def daily_pick():
        r = daily_picks.generate(conn, today)  # skips a day that already has candidates
        cur = conn.cursor()
        cur.execute(
            """
            SELECT c.title FROM daily_pick_candidates c
            LEFT JOIN daily_pick_state s ON s.pick_date = c.pick_date
            WHERE c.pick_date = %s ORDER BY (c.rank = COALESCE(s.current_rank, 1)) DESC, c.rank LIMIT 1
            """,
            (today,),
        )
        row = cur.fetchone()
        if row is None:
            return {"generated": r.status, "notified": 0}
        n = push(conn, kind="daily_pick", title="Today's pick is ready", body=row[0], url="/home",
                 dedupe_key=f"daily:{today}")
        return {"generated": r.status, "notified": n}

    step("daily_pick", daily_pick)

    def tokens():
        sent = 0
        for notice in token_notices(conn, today):
            sent += push(conn, kind="token", title="Reconnect Spotify", body=notice["body"],
                         url="/settings", dedupe_key=notice["key"])
        return sent

    step("token_notices", tokens)
    step("rules_catalog", lambda: export_rules_catalog(conn))

    def collections():
        # v0.84 (R4): YouTube III.E.4 30-day refresh/delete + SoundCloud oEmbed refresh.
        # A no-op before migration 0024 (the tables don't exist yet).
        import psycopg

        from lib.collections_refresh import refresh

        try:
            return refresh(conn)
        except psycopg.errors.UndefinedTable:
            conn.rollback()
            return "skipped: migration 0024 not applied"

    step("collections", collections)

    def wrapped():
        # v0.86 (R6): freeze last year's Rotor Wrapped on 1 January (or the first run after it
        # that finds it missing). A no-op before migration 0027.
        from lib import wrapped as w

        return w.daily_step(conn, today, push)

    step("wrapped", wrapped)
    return summary
