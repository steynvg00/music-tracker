"""Daily monitor: alert by email when Spotify has plays that our DB does not.

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
  - STALE (Spotify ahead of DB): email, GitHub ::warning:: annotation, exit 0.
  - Spotify API/auth failing: email, exit 1 (the monitor itself is blind).
  - spotify_plays empty: email, exit 1.

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
from html import escape

from dotenv import load_dotenv
import psycopg

from lib.email_notify import _smtp_send
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
) -> tuple[str, str, str]:
    """Return (subject, html_body, plaintext_body) for the empty-table or stale alert."""
    url = actions_url()

    if db_latest is None:
        subject = "music-tracker: ingest ALERT — spotify_plays is empty"
        headline = "spotify_plays contains no rows at all."
        lines = ["Newest play in DB: none — the table is empty."]
    else:
        missing = spotify_latest - db_latest
        subject = f"music-tracker: ingest STALE — DB is {format_gap(missing)} behind Spotify"
        headline = "Spotify has plays that the database does not."
        lines = [
            f"Newest play on Spotify: {format_ts(spotify_latest)}",
            f"Newest play in DB: {format_ts(db_latest)}",
            f"Missing window: {format_gap(missing)} "
            f"(threshold {format_gap(LAG_THRESHOLD)}).",
        ]

    plaintext = "\n".join([
        headline,
        "",
        *lines,
        "",
        f"Check the Actions page: {url}",
        "",
        "Most likely cause: GitHub disabled the scheduled workflows after 60 days",
        "without a push. Re-enable them there, then check that keepalive.yml ran.",
    ])

    html_lines = "\n".join(
        f'  <p style="margin:0 0 6px;"><strong>{escape(line)}</strong></p>' for line in lines
    )
    html = f"""\
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;">
  <h2 style="margin:0 0 12px;color:#b00020;">{headline}</h2>
{html_lines}
  <p style="margin:16px 0 16px;">
    <a href="{url}" style="background:#1db954;color:#fff;padding:10px 16px;
       border-radius:6px;text-decoration:none;display:inline-block;">Open the Actions page</a>
  </p>
  <p style="margin:0;color:#555;font-size:14px;">
    Most likely cause: GitHub disabled the scheduled workflows after 60 days without a
    push. Re-enable them there, then check that <code>keepalive.yml</code> ran.
  </p>
</body></html>"""

    return subject, html, plaintext


def build_spotify_failure_alert(exc: BaseException) -> tuple[str, str, str]:
    """Return (subject, html_body, plaintext_body) for a failing Spotify API/auth call."""
    subject = "music-tracker: ingest ALERT — Spotify API/auth failing"
    headline = "The freshness monitor could not query Spotify."
    error_line = f"{type(exc).__name__}: {exc}"
    cause = (
        "Likely cause: SPOTIFY_REFRESH_TOKEN has expired or been revoked, or a "
        "Spotify secret (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / "
        "SPOTIFY_REFRESH_TOKEN) is missing. The ingest itself uses the same "
        "credentials, so it is probably failing too."
    )
    url = actions_url()

    plaintext = "\n".join([
        headline,
        "",
        f"Error: {error_line}",
        "",
        cause,
        "",
        f"Check the Actions page: {url}",
    ])

    html = f"""\
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;">
  <h2 style="margin:0 0 12px;color:#b00020;">{headline}</h2>
  <p style="margin:0 0 16px;"><strong>Error:</strong> <code>{escape(error_line)}</code></p>
  <p style="margin:0 0 16px;">{escape(cause)}</p>
  <p style="margin:0;">
    <a href="{url}" style="background:#1db954;color:#fff;padding:10px 16px;
       border-radius:6px;text-decoration:none;display:inline-block;">Open the Actions page</a>
  </p>
</body></html>"""

    return subject, html, plaintext


def deliver(alert: tuple[str, str, str], dry_run: bool) -> None:
    """Send the alert, or print it in --dry-run. SMTP errors propagate (exit 1)."""
    subject, html, plaintext = alert
    if dry_run:
        print(f"[freshness] DRY RUN — would send subject={subject}", flush=True)
        print(plaintext, flush=True)
        return
    _smtp_send(subject, html, plaintext)
    print(f"[freshness] Alert sent: {subject}", flush=True)


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
        db_latest = fetch_last_played_at(conn)
    finally:
        conn.close()

    if db_latest is None:
        deliver(build_alert(None), args.dry_run)
        return 1

    print("[freshness] Querying Spotify for the newest play...", flush=True)
    try:
        spotify_latest = fetch_spotify_latest()
    except Exception as exc:
        print(f"[freshness] Spotify call failed: {type(exc).__name__}: {exc}", flush=True)
        deliver(build_spotify_failure_alert(exc), args.dry_run)
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

    deliver(build_alert(db_latest, spotify_latest), args.dry_run)
    if args.dry_run:
        return 1
    print("::warning::Ingest stale — alert emailed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
