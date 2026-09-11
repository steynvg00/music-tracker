"""Daily monitor: alert by email when the Spotify play ingest has gone stale.

Queries max(played_at) from spotify_plays and compares it against now(). If the
gap exceeds STALE_THRESHOLD, sends an alert and exits non-zero (so the Actions
run goes red too); otherwise prints the gap and exits zero.

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

from lib.email_notify import _smtp_send

# How far behind max(played_at) may fall before we treat the ingest as broken.
# The Spotify recently-played cron runs every 30 minutes, so 6 hours is roughly
# twelve consecutive misses — comfortably clear of a normal quiet period.
STALE_THRESHOLD = timedelta(hours=6)

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


def fetch_last_played_at(conn) -> datetime | None:
    """Newest played_at in spotify_plays, or None when the table is empty."""
    with conn.cursor() as cur:
        cur.execute("SELECT max(played_at) FROM spotify_plays")
        return cur.fetchone()[0]


def build_alert(last_played_at: datetime | None, gap: timedelta | None) -> tuple[str, str, str]:
    """Return (subject, html_body, plaintext_body) for the stale-ingest alert."""
    url = actions_url()

    if last_played_at is None:
        subject = "music-tracker: ingest ALERT — spotify_plays is empty"
        headline = "spotify_plays contains no rows at all."
        last_line = "Last play: none — the table is empty."
        gap_line = f"Gap: unmeasurable (threshold is {format_gap(STALE_THRESHOLD)})."
    else:
        subject = f"music-tracker: ingest STALE — no plays for {format_gap(gap)}"
        headline = "The Spotify play ingest has stopped landing rows."
        last_line = f"Last play: {last_played_at.astimezone(timezone.utc):%Y-%m-%d %H:%M UTC}"
        gap_line = (
            f"Gap: {format_gap(gap)} — over the "
            f"{format_gap(STALE_THRESHOLD)} threshold."
        )

    plaintext = "\n".join([
        headline,
        "",
        last_line,
        gap_line,
        "",
        f"Check the Actions page: {url}",
        "",
        "Most likely cause: GitHub disabled the scheduled workflows after 60 days",
        "without a push. Re-enable them there, then check that keepalive.yml ran.",
    ])

    html = f"""\
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;">
  <h2 style="margin:0 0 12px;color:#b00020;">{headline}</h2>
  <p style="margin:0 0 6px;"><strong>{last_line}</strong></p>
  <p style="margin:0 0 16px;">{gap_line}</p>
  <p style="margin:0 0 16px;">
    <a href="{url}" style="background:#1db954;color:#fff;padding:10px 16px;
       border-radius:6px;text-decoration:none;display:inline-block;">Open the Actions page</a>
  </p>
  <p style="margin:0;color:#555;font-size:14px;">
    Most likely cause: GitHub disabled the scheduled workflows after 60 days without a
    push. Re-enable them there, then check that <code>keepalive.yml</code> ran.
  </p>
</body></html>"""

    return subject, html, plaintext


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Alert when the Spotify play ingest has gone stale."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Run the query and print what would be sent, without sending anything.",
    )
    args = parser.parse_args()

    load_dotenv()
    db_url = os.environ["DATABASE_URL"]

    print("[freshness] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)
    try:
        last_played_at = fetch_last_played_at(conn)
    finally:
        conn.close()

    now = datetime.now(timezone.utc)
    gap = None if last_played_at is None else now - last_played_at

    if gap is not None and gap <= STALE_THRESHOLD:
        print(
            f"[freshness] OK — last play {last_played_at.astimezone(timezone.utc):%Y-%m-%d %H:%M UTC}, "
            f"gap {format_gap(gap)} (threshold {format_gap(STALE_THRESHOLD)}).",
            flush=True,
        )
        return 0

    subject, html, plaintext = build_alert(last_played_at, gap)

    if args.dry_run:
        print(f"[freshness] DRY RUN — would send subject={subject}", flush=True)
        print(plaintext, flush=True)
        return 1

    _smtp_send(subject, html, plaintext)
    print(f"[freshness] STALE — alert sent: {subject}", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
