"""Listening hours for API-ingested plays (v0.83, migration 0026).

Plays from the recently-played API have ms_played = NULL. Before 0026 every hours/ms rollup summed
ms_played as-is, so a month of API plays read "0 h". These tests run against a throwaway
Postgres 16 (initdb in a temp dir; never the real database) with every migration in
migrations/ applied in number order (the session fixture pg_url in conftest.py), and are
skipped when no Postgres 16+ binaries are found. Set PG_BIN to point at them explicitly.
"""
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
import pytest

from lib import listening_time

ROOT = Path(__file__).resolve().parent.parent
AMS = ZoneInfo("Europe/Amsterdam")
DUR_A, DUR_C = 200_000, 180_000


@pytest.fixture
def conn(pg_url):
    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("TRUNCATE spotify_plays, track_metadata RESTART IDENTITY CASCADE")
        yield c


def _today(conn) -> date:
    return conn.execute("SELECT (now() AT TIME ZONE 'Europe/Amsterdam')::date").fetchone()[0]


def _play(conn, at: datetime, uri: str, ms: int | None, name: str = "Song", artist: str = "Artist"):
    conn.execute(
        """INSERT INTO spotify_plays (played_at, ms_played, platform, track_uri, track_name, artist_name, album_name, reason_end, shuffle)
           VALUES (%s, %s, 'iOS 17.1 (iPhone15,2)', %s, %s, %s, 'Album', 'trackdone', false)""",
        (at, ms, uri, name, artist),
    )


def _meta(conn, uri: str, duration: int):
    conn.execute("INSERT INTO track_metadata (track_uri, duration_ms) VALUES (%s, %s)", (uri, duration))


def _at(d: date, hour: int, minute: int = 0) -> datetime:
    return datetime.combine(d, time(hour, minute), AMS)


def test_api_plays_count_their_track_duration_in_every_rollup(conn):
    today = _today(conn)
    _meta(conn, "spotify:track:A", DUR_A)
    for m in range(3):                                    # three API plays: no ms_played
        _play(conn, _at(today, 1, m), "spotify:track:A", None)
    _play(conn, _at(today, 1, 10), "spotify:track:A", 60_000)  # one export play: ms_played wins
    _play(conn, _at(today, 1, 20), "spotify:track:B", None, name="Unenriched")  # no metadata: 0
    conn.execute("SELECT hub.refresh_rollups(true)")
    want = 3 * DUR_A + 60_000

    assert conn.execute("SELECT ms FROM hub.daily_listening WHERE d = %s", (today,)).fetchone()[0] == want
    assert conn.execute("SELECT sum(ms) FROM hub.day_track WHERE d = %s", (today,)).fetchone()[0] == want
    assert conn.execute("SELECT sum(ms) FROM hub.behaviour_daily WHERE d = %s", (today,)).fetchone()[0] == want
    assert conn.execute("SELECT ms FROM hub.mv_track_stats WHERE track_uri = 'spotify:track:A'").fetchone()[0] == want
    assert conn.execute("SELECT ms FROM hub.mv_totals").fetchone()[0] == want
    hours = conn.execute("SELECT (hub.home_payload(%s) -> 'month' ->> 'hours')::numeric", (today,)).fetchone()[0]
    assert float(hours) == round(want / 3_600_000, 1) > 0


def test_incremental_refresh_picks_up_durations_enriched_after_the_ingest(conn):
    today = _today(conn)
    day = today - timedelta(days=1)                       # a day the next ingest will not touch again
    _meta(conn, "spotify:track:A", DUR_A)
    _play(conn, _at(day, 23, 50), "spotify:track:A", None)
    conn.execute("SELECT hub.refresh_rollups(true)")      # full, sets full_rebuilt_at = now
    _play(conn, _at(day, 23, 55), "spotify:track:C", None, name="Late")
    conn.execute("SELECT hub.refresh_rollups()")          # incremental: C not enriched yet → 0 ms
    assert conn.execute("SELECT ms FROM hub.daily_listening WHERE d = %s", (day,)).fetchone()[0] == DUR_A

    _meta(conn, "spotify:track:C", DUR_C)                 # enrichment job runs after the ingest
    _play(conn, _at(today, 9), "spotify:track:A", None)   # next ingest: only touches today
    out = conn.execute("SELECT hub.refresh_rollups()").fetchone()[0]
    assert out["days"] != "full"
    assert conn.execute("SELECT ms FROM hub.daily_listening WHERE d = %s", (day,)).fetchone()[0] == DUR_A + DUR_C
    assert conn.execute("SELECT ms FROM hub.mv_track_stats WHERE track_uri = 'spotify:track:C'").fetchone()[0] == DUR_C
    full = conn.execute("SELECT sum(ms) FROM hub.daily_listening").fetchone()[0]
    conn.execute("SELECT hub.refresh_rollups(true)")      # incremental == full
    assert conn.execute("SELECT sum(ms) FROM hub.daily_listening").fetchone()[0] == full


def test_reference_hours_sql_uses_the_same_fallback(conn):
    """lib/listening_time.py is the SQL Streamlit's Spotify tab ran (v1.0: kept as the parity reference)."""
    today = _today(conn)
    _meta(conn, "spotify:track:A", 1_800_000)
    _play(conn, _at(today, 1), "spotify:track:A", None)
    _play(conn, _at(today, 2), "spotify:track:A", None)
    _play(conn, _at(today, 3), "spotify:track:A", 1_800_000)
    conn.execute("SELECT hub.refresh_rollups(true)")
    hub_ms = conn.execute("SELECT ms FROM hub.mv_totals").fetchone()[0]

    overview = conn.execute(listening_time.SPOTIFY_OVERVIEW_SQL).fetchone()
    assert float(overview[1]) == round(hub_ms / 3_600_000, 1) == 1.5
    by_year = conn.execute(listening_time.SPOTIFY_HOURS_BY_YEAR_SQL).fetchall()
    assert [(y, float(h)) for y, h in by_year] == [(today.year, 1.5)]
    album = conn.execute(listening_time.ALBUM_SUMMARY_SQL, ("Album",)).fetchone()
    assert float(album[4]) == 1.5
