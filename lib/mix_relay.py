"""Mixed sessions, iPhone relay mode (v0.85, R5). A hub job of kind 'mix_relay'.

On a locked iPhone the page's JavaScript is suspended, so nothing can start the YouTube or
SoundCloud part when Spotify's part ends (01-feasibility.md §6.3 F1). The page therefore tells
the hub when its Spotify part should end; this job waits for that moment and sends a Web Push
"Spotify part finished — tap to continue on YouTube". Opening it shows the tap card.

Timer-based on purpose: the crons' Spotify token has no playback scope, and waiting costs no
Spotify quota (F14). If the page moved on by itself (it was open), no push is sent.
Waits at most 18 minutes (hub-jobs.yml has a 20-minute job timeout).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

MAX_WAIT_S = 18 * 60


def _moved_on(conn, session_id: str, position: int) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT position, ended_at FROM playback_sessions WHERE id = %s", (session_id,))
    row = cur.fetchone()
    conn.commit()
    return row is None or row[1] is not None or row[0] >= position


def relay(conn, payload: dict, ctx: dict, *, sleep=time.sleep, now=lambda: datetime.now(timezone.utc)) -> dict:
    session_id = str(payload.get("session_id"))
    mix_id = str(payload.get("mix_id"))
    position = int(payload.get("position"))
    label = str(payload.get("label") or "YouTube")[:40]
    notify_at = datetime.fromisoformat(str(payload.get("notify_at")).replace("Z", "+00:00"))
    deadline = time.monotonic() + MAX_WAIT_S
    while True:
        if _moved_on(conn, session_id, position):
            return {"skipped": True, "reason": "the page carried on by itself"}
        remaining = (notify_at - now()).total_seconds()
        if remaining <= 0 or time.monotonic() >= deadline:
            break
        sleep(min(30.0, remaining))  # also keeps the DB connection alive
    n = ctx["push"](
        conn,
        kind="mix_relay",
        title="Rotor mix",
        body=f"Spotify part finished — tap to continue on {label}",
        url=f"/elsewhere/mix/{mix_id}?session={session_id}&at={position}",
        tag=f"mix-{session_id}",
    )
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO handoff_events (session_id, from_source, to_source, position, outcome, detail) VALUES (%s, 'spotify', %s, %s, 'relay', %s::jsonb)",
        (session_id, label.lower() if label.lower() in ("youtube", "soundcloud") else None, position, '{"delivered": %d}' % n),
    )
    conn.commit()
    return {"delivered": n}
