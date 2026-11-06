"""Listening hours for API-ingested plays (v0.83, migration 0026).

Plays from the recently-played API have ms_played = NULL. Before 0026 every hours/ms rollup summed
ms_played as-is, so a month of API plays read "0 h". These tests run against a throwaway
Postgres 16 (initdb in a temp dir; never the real database) with every migration in
migrations/ applied in number order, and are skipped when no Postgres 16+ binaries are found.
Set PG_BIN to point at them explicitly.
"""
import os
import re
import shutil
import socket
import subprocess
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
import pytest

from lib import listening_time

ROOT = Path(__file__).resolve().parent.parent
AMS = ZoneInfo("Europe/Amsterdam")
DUR_A, DUR_C = 200_000, 180_000


def _pg_bin() -> Path | None:
    candidates = [os.environ.get("PG_BIN"), "/usr/local/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@16/bin"]
    candidates += sorted((str(p) for p in Path("/usr/lib/postgresql").glob("*/bin")), reverse=True)
    for c in candidates:
        if not c or not (Path(c) / "initdb").exists():
            continue
        out = subprocess.run([str(Path(c) / "initdb"), "--version"], capture_output=True, text=True).stdout
        m = re.search(r"(\d+)", out)
        if m and int(m.group(1)) >= 16:
            return Path(c)
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    pg_bin = _pg_bin()
    if pg_bin is None:
        pytest.skip("no Postgres 16+ binaries (brew install postgresql@16, or set PG_BIN)")
    data = tmp_path_factory.mktemp("pg") / "data"
    port = _free_port()
    env = {**os.environ, "LC_ALL": "en_US.UTF-8", "LANG": "en_US.UTF-8"}
    subprocess.run([pg_bin / "initdb", "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C",
                    "-c", "timezone=UTC"], check=True, capture_output=True, env=env)
    subprocess.run([pg_bin / "pg_ctl", "-D", data, "-o", f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''",
                    "-l", data.parent / "pg.log", "-w", "start"], check=True, capture_output=True, env=env)
    url = f"postgresql://postgres@127.0.0.1:{port}/postgres"
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            for f in sorted((ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")):
                conn.execute(f.read_text())
        yield url
    finally:
        subprocess.run([pg_bin / "pg_ctl", "-D", data, "-m", "fast", "stop"], capture_output=True, env=env)
        shutil.rmtree(data, ignore_errors=True)


@pytest.fixture
def conn(db):
    with psycopg.connect(db, autocommit=True) as c:
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


def test_streamlit_hours_use_the_same_fallback(conn):
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


def test_streamlit_pages_use_the_shared_queries():
    stats = (ROOT / "views" / "stats.py").read_text()
    album = (ROOT / "views" / "_stats_album_lookup.py").read_text()
    assert "SUM(ms_played)" not in stats and "SUM(ms_played)" not in album
    assert "SPOTIFY_OVERVIEW_SQL" in stats and "SPOTIFY_HOURS_BY_YEAR_SQL" in stats
    assert "ALBUM_SUMMARY_SQL" in album
