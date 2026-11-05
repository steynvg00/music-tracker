"""Rotor stats rollups (v0.83, R3): refresh hub.* materialized views after an ingest.

migrations/0023_hub_stats_rollups.sql defines the views and hub.refresh_rollups(), which
refreshes them CONCURRENTLY (readers are never blocked) and returns per-view timings.

Never fatal: the plays are committed before this runs, so a rollup problem must not fail
the ingest cron. Before 0023 is applied the function doesn't exist and this is a no-op.
"""

from __future__ import annotations

import json
import sys

import psycopg
from psycopg.pq import TransactionStatus


def refresh_rollups(conn) -> dict | None:
    """Run hub.refresh_rollups(). Returns its timings dict, or None when skipped/failed."""
    # Leave whatever came before in a clean state: commit good work, drop an aborted one.
    if conn.info.transaction_status == TransactionStatus.INERROR:
        conn.rollback()
    else:
        conn.commit()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT hub.refresh_rollups()")
            row = cur.fetchone()
        conn.commit()
    except (psycopg.errors.UndefinedFunction, psycopg.errors.InvalidSchemaName):
        conn.rollback()
        print("[rollups] hub.refresh_rollups() not found (migration 0023 not applied); skipped.", flush=True)
        return None
    except Exception as e:  # noqa: BLE001 — never fail the ingest over rollups
        conn.rollback()
        print(f"WARNING: rollup refresh failed: {e}", file=sys.stderr, flush=True)
        return None
    result = row[0] if row else None
    if isinstance(result, str):
        result = json.loads(result)
    if result and result.get("skipped"):
        print("[rollups] another refresh is running; skipped.", flush=True)
    elif result:
        print(f"[rollups] refreshed in {result.get('total_ms')} ms: {result}", flush=True)
    return result
