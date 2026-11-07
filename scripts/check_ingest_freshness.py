"""Daily monitor: alert by Web Push when Spotify has plays that our DB does not.

Asks Spotify for the single most recent play (/me/player/recently-played,
limit=1) and compares its played_at against max(played_at) in spotify_plays.
The ingest is STALE only when Spotify's newest play is more than LAG_THRESHOLD
ahead of the DB's newest play — i.e. plays exist upstream that never landed.

A quiet period (no listening) is not a failure: when nothing new was played,
Spotify and the DB agree on the newest play and the check passes, however long
ago that play was. The previous check (now - max(played_at) > 6h) could not
tell "not listening" from "ingest broken" and raised false alarms whenever the
monitor ran after a stretch without music.

Alert paths:
  - STALE (Spotify ahead of DB): push, GitHub ::warning:: annotation, exit 0.
  - Spotify API/auth failing: push, exit 1 (the monitor itself is blind).
  - spotify_plays empty: push, exit 1.
  - The push reached no device: ::error:: annotation and exit 1, so GitHub's own
    "workflow failed" notification is the safety net (v0.89: there is no mail any more).

Background: on 2026-09-11 every cron was found to have been silent since ~6
September, and roughly 5.5 days of listening history were lost because
/me/player/recently-played only returns the last 50 tracks. The crons stopping
was survivable; not noticing for five days was not.

Run locally:
    uv run python -m scripts.check_ingest_freshness --dry-run
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import os
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
import psycopg

from lib import notify
from lib.spotify import get_spotify_client

# How far Spotify's newest play may run ahead of the DB's newest play before we
# call the ingest stale. The ingest runs every 30 minutes; the rest of the
# margin absorbs GitHub cron delays (runs are routinely late by an hour+).
LAG_THRESHOLD = timedelta(hours=2)

# Used to build the Actions link when GITHUB_REPOSITORY is absent (local runs).
DEFAULT_REPO = "steynvg00/music-tracker"


def actions_url() -> str:
    """Direct link to this repository's Actions page."""
    repo = os.environ.get("GITHUB_REPOSITORY") or DEFAULT_REPO
    return f"https://github.com/{repo}/actions"


def format_gap(gap: timedelta) -> str:
    """Render a timedelta as e.g. '3d 4h 07m' — readable at a glance on a phone."""
    total_minutes = int(gap.total_seconds() // 60)
    days, rem = divmod(total_minutes, 60 * 24)
    hours, minutes = divmod(rem, 60)
    if days:
        return f"{days}d {hours}h {minutes:02d}m"
    return f"{hours}h {minutes:02d}m"


def format_ts(ts: datetime) -> str:
    return f"{ts.astimezone(timezone.utc):%Y-%m-%d %H:%M UTC}"


def fetch_last_played_at(conn) -> datetime | None:
    """Newest played_at in spotify_plays, or None when the table is empty."""
    with conn.cursor() as cur:
        cur.execute("SELECT max(played_at) FROM spotify_plays")
        return cur.fetchone()[0]


def parse_played_at(value: str) -> datetime:
    """Parse Spotify's ISO played_at (e.g. '2026-09-28T17:14:03.123Z') as tz-aware UTC."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def fetch_spotify_latest() -> datetime | None:
    """Newest played_at according to Spotify, or None when it returns no items.

    Raises on any client/auth/API failure; the caller turns that into an alert.
    """
    sp = get_spotify_client()
    response = sp.current_user_recently_played(limit=1)
    items = (response or {}).get("items") or []
    if not items:
        return None
    return parse_played_at(items[0]["played_at"])


def build_alert(
    db_latest: datetime | None, spotify_latest: datetime | None = None
) -> tuple[str, str]:
    """Return (title, body) of the push for the empty-table or stale alert."""
    if db_latest is None:
        return ("Ingest alert: no plays in the database",
                "spotify_plays is empty. Check the Actions page and Rotor's Data health.")
    missing = spotify_latest - db_latest
    return (f"Ingest stale: {format_gap(missing)} behind Spotify",
            f"Spotify's newest play is {format_ts(spotify_latest)}, the database's {format_ts(db_latest)}. "
            "Most likely the scheduled workflows were disabled: re-enable them and check keepalive.yml.")


def build_spotify_failure_alert(exc: BaseException) -> tuple[str, str]:
    """Return (title, body) of the push for a failing Spotify API/auth call."""
    return ("Ingest alert: Spotify API/auth failing",
            f"{type(exc).__name__}: {str(exc)[:160]}. The refresh token probably expired or was revoked; "
            "the ingest uses the same credentials, so it is probably failing too.")


def deliver(conn, alert: tuple[str, str], dry_run: bool) -> int:
    """Push the alert (kind 'ingest_alert'), or print it in --dry-run. Returns devices reached.

    v0.89: a push instead of a mail. When it reaches no device (VAPID missing, no device
    subscribed, or the type switched off), the caller fails the run so GitHub's own
    "workflow failed" notification is the safety net.
    """
    title, body = alert
    if dry_run:
        print(f"[freshness] DRY RUN — would push: {title} — {body}", flush=True)
        return 1
    n = notify.notify(conn, "ingest_alert", title=title, body=body, url="/settings/health")
    print(f"[freshness] Alert pushed to {max(n, 0)} device(s): {title}", flush=True)
    if n <= 0:
        print(f"::error::Ingest alert could not be pushed to any device: {title} — see {actions_url()}", flush=True)
    return n


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Alert when Spotify has plays that the DB ingest has not landed."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Run the checks and print what would be sent, without sending anything.",
    )
    args = parser.parse_args()

    load_dotenv()
    db_url = os.environ["DATABASE_URL"]

    print("[freshness] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)
    try:
        return _check(conn, args.dry_run)
    finally:
        conn.close()


def _check(conn, dry_run: bool) -> int:
    db_latest = fetch_last_played_at(conn)
    if db_latest is None:
        deliver(conn, build_alert(None), dry_run)
        return 1

    print("[freshness] Querying Spotify for the newest play...", flush=True)
    try:
        spotify_latest = fetch_spotify_latest()
    except Exception as exc:
        print(f"[freshness] Spotify call failed: {type(exc).__name__}: {exc}", flush=True)
        deliver(conn, build_spotify_failure_alert(exc), dry_run)
        return 1

    now = datetime.now(timezone.utc)
    if spotify_latest is None or spotify_latest <= db_latest + LAG_THRESHOLD:
        spotify_desc = "no items" if spotify_latest is None else format_ts(spotify_latest)
        print(
            f"[freshness] OK — newest on Spotify {spotify_desc}, "
            f"newest in DB {format_ts(db_latest)}, "
            f"quiet period {format_gap(now - db_latest)} "
            f"(lag threshold {format_gap(LAG_THRESHOLD)}).",
            flush=True,
        )
        return 0

    n = deliver(conn, build_alert(db_latest, spotify_latest), dry_run)
    if dry_run:
        return 1
    if n <= 0:
        return 1  # nobody was told: let GitHub's failure notification do it
    print("::warning::Ingest stale — alert pushed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
