"""Rotor Wrapped (v0.86, R6): build and freeze a year's story.

The story itself is one SQL function, hub.wrapped_payload(year, through) (migration 0027), over
the R3 rollups. This module only freezes past years:

  * freeze(conn, year, source) → hub.wrapped_freeze(): builds the payload once and stores it in
    wrapped_snapshots. It never overwrites (a trigger refuses UPDATE), so a frozen year never
    changes, whatever happens to the plays afterwards.
  * daily_step(conn, today, push) runs in the daily hub-jobs.yml run. When last year has no
    snapshot (so on 1 January, and on any later day if that run failed), it builds it and sends
    one "Your Rotor Wrapped <year> is ready" push (deduplicated per year).

The hub job kind 'wrapped_build' (lib/hub_jobs.py) calls freeze() for "Build" in Stats › Wrapped.
"""
from __future__ import annotations

from datetime import date

MIN_YEAR = 2017  # first year with data in this library


class WrappedError(ValueError):
    """A year that can't be frozen (shown as-is in the hub)."""


def valid_year(year, today: date) -> int:
    try:
        y = int(year)
    except (TypeError, ValueError):
        raise WrappedError("payload.year must be a year like 2025") from None
    if y < MIN_YEAR or y >= today.year:
        raise WrappedError(f"Rotor Wrapped can be built for {MIN_YEAR} … {today.year - 1} (got {y})")
    return y


def freeze(conn, year: int, source: str = "job") -> dict:
    """Build + store one past year once. {'year', 'created', 'generatedAt', 'buildMs'}."""
    cur = conn.cursor()
    cur.execute("SELECT hub.wrapped_freeze(%s, %s)", (year, source))
    out = cur.fetchone()[0]
    conn.commit()
    return out


def has_snapshot(conn, year: int) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM wrapped_snapshots WHERE year = %s", (year,))
    return cur.fetchone() is not None


def daily_step(conn, today: date, push) -> dict | str:
    """Freeze last year if it's missing; one push when a snapshot was created."""
    import psycopg

    year = today.year - 1
    try:
        if has_snapshot(conn, year):
            return {"year": year, "created": False}
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        return "skipped: migration 0027 not applied"
    r = freeze(conn, year, "daily")
    if r.get("created"):
        r["notified"] = push(conn, kind="wrapped", title="Rotor Wrapped", body=f"Your Rotor Wrapped {year} is ready",
                             url=f"/wrapped/{year}", dedupe_key=f"wrapped:{year}")
    return r
