"""Rotor Wrapped (v0.86, R6): hub.wrapped_payload / hub.wrapped_freeze (migration 0027) on a
throwaway Postgres 16 (conftest.pg_url), lib/wrapped.py and the wrapped_build hub job."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import psycopg
import pytest

from lib import hub_jobs, wrapped

AMS = ZoneInfo("Europe/Amsterdam")
TODAY = datetime.now(AMS).date()
Y = TODAY.year - 1            # the year under test (a past year → can be frozen)
DUR = 200_000


@pytest.fixture
def conn(pg_url):
    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("TRUNCATE spotify_plays, track_metadata, badge_events, wrapped_snapshots, hub_jobs, push_log RESTART IDENTITY CASCADE")
        yield c


def at(d: date, hour: int = 12, minute: int = 0) -> datetime:
    return datetime.combine(d, time(hour, minute), AMS)


def play(c, when: datetime, artist: str, track: str, ms: int | None = 180_000):
    uri = f"spotify:track:{(artist + track).replace(' ', '')[:22].ljust(22, 'x')}"
    c.execute("""INSERT INTO spotify_plays (played_at, ms_played, platform, track_uri, track_name, artist_name, album_name, reason_end, shuffle)
                 VALUES (%s, %s, 'iOS 17', %s, %s, %s, 'Album', 'trackdone', false)""", (when, ms, uri, track, artist))
    return uri


def seed(c):
    # Two years before: "Old Friend" last heard in March, two years ago.
    play(c, at(date(Y - 2, 3, 1)), "Old Friend", "Classic")
    # Previous year: a little, incl. an artist who keeps playing (no comeback).
    for k in range(3):
        play(c, at(date(Y - 1, 12, 20), 10, k), "Regular", "Steady")
    # The year itself.
    for day in (date(Y, 1, 1), date(Y, 1, 2), date(Y, 1, 3), date(Y, 1, 4)):  # a 4-day streak
        play(c, at(day, 9), "Regular", "Steady")
    play(c, at(date(Y, 1, 10), 9), "Regular", "Steady")
    for k in range(6):                                                        # biggest day + discovery
        play(c, at(date(Y, 6, 15), 22, k), "Newcomer", "First Love")
    play(c, at(date(Y, 6, 16), 8), "Old Friend", "Classic")                   # comeback (> 12 months)
    uri = play(c, at(date(Y, 6, 17), 8), "Newcomer", "API Play", ms=None)    # API play: duration fallback
    c.execute("INSERT INTO track_metadata (track_uri, duration_ms) VALUES (%s, %s)", (uri, DUR))
    c.execute("""INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at) VALUES
                 ('track', 'spotify:track:a', 'plays_50', %s), ('track', 'spotify:track:b', 'plays_100', %s),
                 ('artist', 'x', 'artist_plays_1000', %s)""", (at(date(Y, 3, 3)), at(date(Y, 9, 9)), at(date(Y - 1, 5, 5))))
    c.execute("SELECT hub.refresh_rollups(true)")


def payload(c, through: date | None = None) -> dict:
    return c.execute("SELECT hub.wrapped_payload(%s, %s)", (Y, through or date(Y, 12, 31))).fetchone()[0]


def test_full_year_payload(conn):
    seed(conn)
    p = payload(conn)
    assert p["year"] == Y and p["live"] is False and p["through"] == f"{Y}-12-31"
    t = p["totals"]
    assert t["plays"] == 13 and t["days"] == 8 and t["noMsPlays"] == 1
    assert t["ms"] == 12 * 180_000 + DUR                                 # 0026 fallback for the API play
    assert t["artists"] == 3 and t["tracks"] == 4
    assert [x["track"] for x in p["topTracks"][:2]] == ["First Love", "Steady"]
    assert p["topTracks"][0]["plays"] == 6 and p["topTracks"][0]["rank"] == 1
    assert [a["artist"] for a in p["topArtists"]] == ["Newcomer", "Regular", "Old Friend"]
    assert p["topArtists"][0]["tracks"] == 2
    # Discoveries: first-ever plays in Y. "Regular" started in Y-1, "Old Friend" in Y-2.
    assert p["discoveries"]["artists"] == 1 and p["discoveries"]["topArtists"][0]["artist"] == "Newcomer"
    assert p["discoveries"]["tracks"] == 2
    # Comebacks: Old Friend (gap from Y-2-03-01 to Y-06-16), not Regular (heard in December).
    cb = p["comebacks"]
    assert cb["artists"] == 1 and cb["topArtists"][0]["artist"] == "Old Friend" and cb["topArtists"][0]["gapDays"] >= 365
    assert cb["tracks"] == 1 and cb["topTracks"][0]["track"] == "Classic"
    assert p["streak"] == {"days": 4, "from": f"{Y}-01-01", "to": f"{Y}-01-04"}
    assert p["biggestDay"]["day"] == f"{Y}-06-15" and p["biggestDay"]["plays"] == 6
    assert p["biggestDay"]["top"]["track"] == "First Love"
    assert len(p["clock"]) == 7 and all(len(r) == 24 for r in p["clock"])
    assert sum(map(sum, p["clock"])) == 13
    assert [m["month"] for m in p["months"]] == list(range(1, 13))
    assert max(p["months"], key=lambda m: m["plays"])["month"] == 6
    assert p["badges"]["count"] == 2 and p["badges"]["byType"] == {"plays_50": 1, "plays_100": 1}
    prev = p["previous"]
    assert prev["year"] == Y - 1 and prev["plays"] == 3 and prev["artists"] == 1 and prev["newArtists"] == 1


def test_so_far_is_live_and_compares_the_same_period(conn):
    seed(conn)
    p = payload(conn, through=date(Y, 1, 31))
    assert p["live"] is True and p["through"] == f"{Y}-01-31"
    assert p["totals"]["plays"] == 5                                     # January only
    assert p["previous"]["through"] == f"{Y - 1}-01-31" and p["previous"]["plays"] == 0


def test_empty_year_is_graceful(conn):
    p = conn.execute("SELECT hub.wrapped_payload(2017, '2017-12-31')").fetchone()[0]
    assert p["totals"]["plays"] == 0 and p["topTracks"] == [] and p["streak"] is None and p["biggestDay"] is None
    assert len(p["clock"]) == 7 and p["discoveries"]["artists"] == 0


def test_freeze_once_and_never_change(conn):
    seed(conn)
    first = wrapped.freeze(conn, Y, "hub")
    assert first["created"] is True and first["year"] == Y
    again = wrapped.freeze(conn, Y, "job")
    assert again["created"] is False and again["generatedAt"] == first["generatedAt"]
    stored = conn.execute("SELECT payload, source, payload_version FROM wrapped_snapshots WHERE year = %s", (Y,)).fetchone()
    assert stored[1] == "hub" and stored[2] == 1 and stored[0]["totals"]["plays"] == 13
    # New plays after freezing don't change the stored year.
    play(conn, at(date(Y, 7, 1)), "Late", "Addition")
    conn.execute("SELECT hub.refresh_rollups(true)")
    assert wrapped.freeze(conn, Y)["created"] is False
    assert conn.execute("SELECT payload->'totals'->>'plays' FROM wrapped_snapshots WHERE year = %s", (Y,)).fetchone()[0] == "13"
    with pytest.raises(psycopg.errors.RaiseException, match="frozen"):
        conn.execute("UPDATE wrapped_snapshots SET build_ms = 0 WHERE year = %s", (Y,))


@pytest.mark.parametrize("year", [2016, TODAY.year, TODAY.year + 1])
def test_freeze_refuses_this_year_and_before_2017(conn, year):
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        conn.execute("SELECT hub.wrapped_freeze(%s)", (year,))
    with pytest.raises(wrapped.WrappedError):
        wrapped.valid_year(year, TODAY)


def test_daily_step_freezes_last_year_once_with_one_push(conn):
    seed(conn)
    pushes = []

    def push(c, **kw):
        pushes.append(kw)
        return 1

    r = wrapped.daily_step(conn, date(TODAY.year, 1, 1), push)
    assert r["created"] is True and r["year"] == Y and r["notified"] == 1
    assert pushes[0]["kind"] == "wrapped" and pushes[0]["url"] == f"/wrapped/{Y}" and pushes[0]["dedupe_key"] == f"wrapped:{Y}"
    assert wrapped.daily_step(conn, date(TODAY.year, 1, 2), push) == {"year": Y, "created": False}
    assert len(pushes) == 1


def _job(conn, payload: dict) -> str:
    import json

    return str(conn.execute("INSERT INTO hub_jobs (kind, payload) VALUES ('wrapped_build', %s::jsonb) RETURNING id",
                            (json.dumps(payload),)).fetchone()[0])


def test_wrapped_build_job(pg_url, conn):
    seed(conn)
    pushes = []
    with psycopg.connect(pg_url) as jc:  # the runner commits itself
        ok = _job(conn, {"year": Y})
        assert hub_jobs.run_job(jc, ok, sp_factory=lambda: None, push=lambda c, **kw: pushes.append(kw) or 1) == "done"
        bad = _job(conn, {"year": TODAY.year})
        assert hub_jobs.run_job(jc, bad, sp_factory=lambda: None, push=lambda c, **kw: pushes.append(kw) or 1) == "failed"
    rows = dict(conn.execute("SELECT id::text, status FROM hub_jobs").fetchall())
    assert rows == {ok: "done", bad: "failed"}
    assert conn.execute("SELECT result->>'created' FROM hub_jobs WHERE id = %s", (ok,)).fetchone()[0] == "true"
    assert "can be built for" in conn.execute("SELECT error FROM hub_jobs WHERE id = %s", (bad,)).fetchone()[0]
    assert pushes[0]["body"] == f"Your Rotor Wrapped {Y} is ready"


def test_kind_check_was_widened_and_keeps_mix_relay(conn):
    check = conn.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'hub_jobs_kind_check'").fetchone()[0]
    for k in ("reseed_daily_pick", "refresh_managed", "push_test", "mix_relay", "wrapped_build"):
        assert k in check
    assert set(hub_jobs.KINDS) <= {"reseed_daily_pick", "refresh_managed", "push_test", "mix_relay", "wrapped_build"}
