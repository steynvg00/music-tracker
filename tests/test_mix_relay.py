"""lib/mix_relay.py (v0.85, R5): push at the end of a Spotify part, unless the page moved on."""
from datetime import datetime, timedelta, timezone

from lib import mix_relay


class _Cur:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=None):
        self.conn.sql.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self.conn.session


class FakeConn:
    def __init__(self, session):
        self.session, self.sql = session, []

    def cursor(self):
        return _Cur(self)

    def commit(self):
        pass


T0 = datetime(2026, 11, 5, 20, 0, tzinfo=timezone.utc)


def payload(sec=60):
    return {"session_id": "s1", "mix_id": "m1", "position": 2, "label": "YouTube", "notify_at": (T0 + timedelta(seconds=sec)).isoformat()}


def test_waits_then_pushes_tap_to_continue():
    clock = {"t": T0}
    sleeps = []

    def sleep(s):
        sleeps.append(s)
        clock["t"] += timedelta(seconds=s)

    pushes = []
    conn = FakeConn((1, None))  # still on position 1 (the Spotify part)
    r = mix_relay.relay(conn, payload(70), {"push": lambda c, **kw: pushes.append(kw) or 1}, sleep=sleep, now=lambda: clock["t"])
    assert r == {"delivered": 1}
    assert sleeps == [30.0, 30.0, 10.0]
    assert pushes[0]["body"] == "Spotify part finished — tap to continue on YouTube"
    assert pushes[0]["url"] == "/elsewhere/mix/m1?session=s1&at=2"
    assert any("'relay'" in q for q, _ in conn.sql)


def test_no_push_when_the_page_already_moved_on():
    pushes = []
    conn = FakeConn((2, None))
    r = mix_relay.relay(conn, payload(), {"push": lambda c, **kw: pushes.append(kw) or 1}, sleep=lambda s: None, now=lambda: T0)
    assert r["skipped"] and pushes == []


def test_no_push_for_an_ended_session():
    conn = FakeConn((0, T0))
    r = mix_relay.relay(conn, payload(), {"push": lambda c, **kw: 1}, sleep=lambda s: None, now=lambda: T0)
    assert r["skipped"]
