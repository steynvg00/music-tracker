"""Notifications (v0.89, R9): every message the crons used to mail is a Web Push now.

Gmail/SMTP is gone (the user dropped it after every mail failed from 2026-10-21). One entry point,
:func:`notify`, sends one push to every subscribed device through ``lib.web_push`` — unless the
type is switched off in Rotor's Settings › Notifications (``notification_prefs``, migration 0030).

  KINDS          every notification type, with the label Settings shows and a sample for "Send test"
  enabled()      the per-type switch; no row (or no 0030 yet) → on
  notify()       send if enabled; returns devices reached (0 = nobody), or -1 when switched off
  send_test()    the "Send test" button: that type's sample, marked as a test, even if switched off

Never fatal: a push problem prints a warning and returns 0, so a cron's real work (plays,
playlists, badges) is never undone by a notification.
"""

from __future__ import annotations

import sys
from typing import Callable

from lib import web_push

# kind → (label, sample title, sample body, sample url). Order = Settings order.
KINDS: dict[str, tuple[str, str, str, str]] = {
    "daily_pick": ("Today's pick is ready", "Today's pick is ready", "A fresh pick for today", "/home"),
    "weekly_digest": ("Weekly refresh digest", "Weekly refresh", "1 playlist created, 2 updated.", "/digest"),
    "monthly_digest": ("Monthly refresh digest", "Monthly refresh", "3 updated.", "/digest"),
    "custom_sweep": ("Custom playlists auto-deleted", "Custom playlists deleted", "1 expired: Late night · Custom 🎧", "/library"),
    "snapshot": ("New snapshot playlists", "Snapshot ready: October 2026", "#1 of 25: a track — an artist", "/library"),
    "milestone": ("Play milestones (50, 100 … 500 plays)", "🏆 100 plays", "a track — an artist", "/stats/badges"),
    "special_badge": ("Special track badges", "⭐ Day-one fan", "a track — an artist", "/stats/badges"),
    "badge_digest": ("Badge digest (per ingest run)", "3 new badges", "On repeat · a track, and 2 more", "/stats/badges"),
    "artist_badge": ("Artist badges", "🎤 #1 artist of the month", "an artist", "/stats/badges"),
    "ingest_alert": ("Ingest freshness alert", "Rotor's play history is behind", "Spotify has plays the database doesn't", "/settings/health"),
    "radar": ("Release radar source failing", "Release radar", "A source has failed 3 days in a row", "/radar"),
    "token": ("Spotify sign-in expiring", "Reconnect Spotify", "The sign-in expires in 14 days", "/settings"),
    "wrapped": ("Rotor Wrapped is ready", "Rotor Wrapped", "Your Rotor Wrapped is ready", "/stats/wrapped"),
    "job": ("A job you started finished", "Rotor", "Refresh now finished", "/settings"),
}

# Tests and the E2E runner swap the transport (never a real push service there).
_transport: Callable | None = None


def set_transport(fn: Callable | None) -> None:
    global _transport
    _transport = fn


def enabled(conn, kind: str) -> bool:
    """The Settings switch for `kind`. Missing row, unknown kind or no table (0030) → on."""
    try:
        with conn.transaction():  # a savepoint: a missing table must not abort the caller's work
            row = conn.execute("SELECT enabled FROM notification_prefs WHERE kind = %s", (kind,)).fetchone()
        return True if row is None else bool(row[0])
    except Exception:
        return True


def _send(conn, **kw) -> int:
    if _transport is not None:
        kw["_webpush"] = _transport
    return web_push.send(conn, **kw)


def notify(conn, kind: str, *, title: str, body: str, url: str = "/home",
           dedupe_key: str | None = None, tag: str | None = None) -> int:
    """One push of type `kind` to every device. Returns devices reached, 0 on any problem, -1 if off."""
    if kind not in KINDS:
        print(f"WARNING: unknown notification kind {kind!r}", file=sys.stderr)
    if not enabled(conn, kind):
        print(f"[notify] '{kind}' is switched off in Settings; not sent.", flush=True)
        return -1
    try:
        n = _send(conn, kind=kind, title=title[:120], body=body[:400], url=url, dedupe_key=dedupe_key, tag=tag)
        print(f"[notify] {kind}: {title} → {n} device(s)", flush=True)
        return n
    except Exception as e:
        print(f"WARNING: '{kind}' push failed: {type(e).__name__}: {e}", file=sys.stderr)
        try:
            conn.rollback()
        except Exception:
            pass
        return 0


def send_test(conn, kind: str, send: Callable | None = None) -> int:
    """The "Send test" button: the type's sample, marked as a test, sent even when switched off.

    `send` is the hub job's push function (web_push.send, or the E2E recorder)."""
    if kind not in KINDS:
        raise ValueError(f"unknown notification kind {kind!r}")
    _label, title, body, url = KINDS[kind]
    kw = dict(kind=kind, title=f"Test · {title}", body=body, url=url, tag=f"test-{kind}")
    return send(conn, **kw) if send is not None else _send(conn, **kw)


def gate(push: Callable) -> Callable:
    """Wrap a hub-job push function (daily pick, token, radar, Wrapped, job finished) so the
    Settings switches apply to it too. Test pushes (kind 'test', tag 'test-…') always go."""
    def gated(conn, **kw):
        kind = kw.get("kind", "")
        if kind != "test" and not str(kw.get("tag") or "").startswith("test-") and not enabled(conn, kind):
            print(f"[notify] '{kind}' is switched off in Settings; not sent.", flush=True)
            return 0
        return push(conn, **kw)

    return gated


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"
