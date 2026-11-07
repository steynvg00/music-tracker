"""Release radar (v0.87, R7): upcoming and new releases from the artists you listen to.

    run(conn, sp_factory=..., push=..., today=...)   ← the daily hub-jobs.yml run (lib/hub_jobs.run_daily)

1. artists.radar_artists(): your top 200 artists of the last 24 months + "Follow in Rotor".
2. Every enabled source adapter, each with its own health row (radar_sources):
     spotify      GET /artists/{id}/albums with the cron token (out releases, last 60 days)
     musicbrainz  releases from 60 days ago to a year ahead (1 request/second, own User-Agent)
     scantraxx    the label's monthly overview pages (this + next month)
   One source failing never stops the others.
3. store.upsert(): merge into radar_releases (normalised artist + title + ±14-day window).
4. store.refresh_in_library(): "In your library" = played or liked.
5. A source that has failed on 3 days in a row → ONE Web Push (R2 push), not one per day.

Beatport is out of scope (R7 spec). Nothing here writes to Spotify; the optional playlist
"New from your artists · Auto 🤖🔄" is written by the hub through its write guard.
"""
from __future__ import annotations

import time
import traceback
from datetime import date
from typing import Callable

from lib.release_radar import artists as artists_mod
from lib.release_radar import store
from lib.release_radar.http import PoliteHttp
from lib.release_radar.sources import musicbrainz, scantraxx, spotify

SOURCES = ("spotify", "musicbrainz", "scantraxx")
LABELS = {"spotify": spotify.LABEL, "musicbrainz": musicbrainz.LABEL, "scantraxx": scantraxx.LABEL}


def _enabled(conn) -> dict[str, bool]:
    cur = conn.cursor()
    cur.execute("SELECT source, enabled FROM radar_sources")
    return dict(cur.fetchall())


def default_http() -> PoliteHttp:
    """MusicBrainz ≥ 1.1 s apart, label pages ≥ 4 s apart. RADAR_GAP_SCALE is a TEST-ONLY knob
    (the E2E run points both sources at one local mock and sets it to 0.01); unset in production."""
    import os
    from urllib.parse import urlsplit

    scale = float(os.environ.get("RADAR_GAP_SCALE", "1") or 1)
    mb = urlsplit(musicbrainz.base_url()).hostname or "musicbrainz.org"
    sx = urlsplit(scantraxx.page_url(1, 2000)).hostname or "scantraxx.com"
    gaps = {mb: 1.1 * scale}
    gaps[sx] = max(gaps.get(sx, 0.0), scantraxx.GAP_SECONDS * scale)  # same host (tests only): the larger gap
    return PoliteHttp(min_gap=gaps, default_gap=1.1 * scale)


def run(conn, *, sp_factory: Callable, push: Callable, today: date, http: PoliteHttp | None = None) -> dict:
    t0 = time.monotonic()
    http = http or default_http()
    radar = artists_mod.radar_artists(conn)
    if not radar:  # nothing to look for: no requests at all
        http.close()
        return {"artists": 0, "sources": {}, "skipped": "no artists"}
    enabled = _enabled(conn)
    summary: dict = {"artists": len(radar), "sources": {}}
    adapters: dict[str, Callable] = {
        "spotify": lambda: spotify.fetch(radar, sp=sp_factory() if any(a.spotify_id for a in radar) else None, today=today),
        "musicbrainz": lambda: musicbrainz.fetch(conn, radar, http=http, today=today),
        "scantraxx": lambda: scantraxx.fetch(radar, http=http, today=today),
    }
    for name in SOURCES:
        if not enabled.get(name, True):
            summary["sources"][name] = {"status": "disabled"}
            continue
        if name == "scantraxx" and not scantraxx.enabled():
            # Off in code until the parser is verified on a real page (sources/scantraxx.py).
            cur = conn.cursor()
            cur.execute("UPDATE radar_sources SET disabled_reason = %s, last_run_at = now() WHERE source = 'scantraxx'",
                        (scantraxx.DISABLED_REASON,))
            conn.commit()
            summary["sources"][name] = {"status": "disabled", "reason": scantraxx.DISABLED_REASON}
            continue
        try:
            res = adapters[name]()
            fatal, items, detail = res.fatal, res.items, {**res.detail, "requests": res.requests, "errors": res.errors[:5]}
        except Exception as e:  # an adapter crash is that source's failure, not the run's
            conn.rollback()
            traceback.print_exc()
            fatal, items, detail = f"{type(e).__name__}: {e}"[:300], [], {}
        written = {"created": 0, "merged": 0}
        if items:
            try:
                written = store.upsert(conn, items)
            except Exception as e:
                conn.rollback()
                traceback.print_exc()
                fatal = fatal or f"store: {type(e).__name__}: {e}"[:300]
        h = store.record_source(conn, name, ok=fatal is None, today=today, items=len(items), error=fatal, detail=detail)
        entry = {"status": "ok" if fatal is None else "failed", "items": len(items), **written}
        if fatal:
            entry["error"] = fatal
            entry["streak_days"] = h["streak_days"]
        if h["notify"]:
            try:
                entry["notified"] = push(conn, kind="radar", title="Release radar",
                                         body=f"{LABELS[name]} has failed {h['streak_days']} days in a row: {fatal}"[:180],
                                         url="/radar", dedupe_key=f"radar-fail:{name}:{h['failing_since']}")
                store.mark_notified(conn, name)
            except Exception:
                conn.rollback()
                traceback.print_exc()
        summary["sources"][name] = entry
    summary["in_library"] = store.refresh_in_library(conn)
    took = int((time.monotonic() - t0) * 1000)
    summary["took_ms"] = took
    cur = conn.cursor()
    import json

    cur.execute("INSERT INTO radar_runs (took_ms, artists, summary) VALUES (%s, %s, %s::jsonb)", (took, len(radar), json.dumps(summary, default=str)))
    conn.commit()
    http.close()
    return summary
