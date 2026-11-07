"""Digest runs stored as data (v0.88, migration 0029) so Rotor can show the Monday mail in-app.

``send_digest`` calls :func:`record_digest` BEFORE it tries to deliver, and :func:`mark_delivery` after,
so a digest is kept even when Gmail is down (as it was from 2026-10-21). Both are best-effort:
a missing table (0029 not applied yet) or any DB error prints a warning and never changes the
digest mail's behaviour or the caller's exit code.

The stored content is exactly what the mail renders, before name hydration: the same
``_aggregate`` grouping, the same previous-rank baseline (``_fetch_previous_ranks``) and the same
"show arrows" rule. Track names are hydrated by the hub at render time from the rollups.
"""

from __future__ import annotations

import json
import sys
from typing import Literal

RunType = Literal["weekly", "monthly", "sweep"]


def digest_content(events, run_type: RunType, conn) -> dict:
    """The digest as JSON: sections, ranked lists with previous ranks, deletions, counts."""
    from lib.email_notify import _aggregate, _fetch_previous_ranks, _should_show_arrows

    aggregates, deleted = _aggregate(events)
    playlists = []
    for a in aggregates:
        if a.created and a.kind == "snapshot":
            section = "snapshot"
        elif a.created:
            section = "created"
        elif a.added or a.removed:
            section = "updated"
        else:
            continue
        ranked: list[dict] = []
        arrows = False
        prev = None
        if a.is_top and a.ranked:
            prev = _fetch_previous_ranks(conn, a.playlist_id)
            arrows = _should_show_arrows(a.ranked, prev)
            for t in a.ranked:
                ranked.append({
                    "uri": t["uri"],
                    "rank": int(t["rank"]),
                    "plays": t.get("plays_in_context"),
                    "prev": prev.get(t["uri"]) if prev is not None else None,
                })
        playlists.append({
            "section": section,
            "name": a.name,
            "kind": a.kind,
            "isTop": a.is_top,
            "playlistId": a.playlist_id or None,
            "description": a.description or None,
            "added": [] if ranked else list(a.added),
            "removed": list(a.removed),
            "addedCount": len(a.added),
            "ranked": ranked,
            "arrows": arrows,
            "baseline": prev is not None,
        })
    dels = [
        {
            "name": e.playlist_name,
            "expiresAt": e.extra.get("expires_at") or None,
            "trackCount": e.extra.get("track_count"),
        }
        for e in deleted
    ] if run_type == "sweep" else []
    counts = {
        "created": sum(1 for p in playlists if p["section"] == "created"),
        "updated": sum(1 for p in playlists if p["section"] == "updated"),
        "snapshots": sum(1 for p in playlists if p["section"] == "snapshot"),
        "deleted": len(dels),
    }
    return {"version": 1, "playlists": playlists, "deleted": dels, "counts": counts}


def record_digest(conn, events, run_type: RunType) -> int | None:
    """Insert one ``digest_runs`` row. Returns its id, or None when it couldn't be stored."""
    from lib.email_notify import _summary_line

    try:
        content = digest_content(events, run_type, conn)
        c = content["counts"]
        summary = _summary_line(c["created"], c["updated"], c["snapshots"], c["deleted"], run_type)
        with conn.transaction():  # a savepoint when the caller is inside a transaction
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO digest_runs (run_type, event_count, summary, content)
                VALUES (%s, %s, %s, %s::jsonb) RETURNING id
                """,
                (run_type, len(events), summary, json.dumps(content)),
            )
            row = cur.fetchone()
        conn.commit()
        return int(row[0]) if row else None
    except Exception as e:  # 0029 not applied, or any DB hiccup: the mail still goes out
        print(f"WARNING: digest not stored for Rotor ({type(e).__name__}: {e})", file=sys.stderr)
        return None


def mark_delivery(conn, digest_id: int | None, status: str, error: str | None = None) -> None:
    """Record how the digest was delivered, e.g. mail_sent | mail_dry_run | mail_failed (best-effort)."""
    if digest_id is None:
        return
    try:
        with conn.transaction():
            conn.cursor().execute(
                "UPDATE digest_runs SET delivery_status = %s, delivery_error = %s WHERE id = %s",
                (status, (error or None) and error[:500], digest_id),
            )
        conn.commit()
    except Exception as e:
        print(f"WARNING: digest delivery status not stored ({type(e).__name__}: {e})", file=sys.stderr)
