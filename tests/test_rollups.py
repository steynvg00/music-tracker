"""lib/rollups.py (v0.83, R3): the ingest's rollup refresh is never fatal."""
import psycopg
from psycopg.pq import TransactionStatus

from lib import rollups


class _Cur:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append(sql)
        if self.conn.raise_exc:
            raise self.conn.raise_exc

    def fetchone(self):
        return (self.conn.result,)


class _Info:
    def __init__(self, status):
        self.transaction_status = status


class FakeConn:
    def __init__(self, result=None, raise_exc=None, status=TransactionStatus.IDLE):
        self.result = result
        self.raise_exc = raise_exc
        self.info = _Info(status)
        self.executed, self.commits, self.rollbacks = [], 0, 0

    def cursor(self):
        return _Cur(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_refresh_returns_timings_and_commits(capsys):
    conn = FakeConn(result={"mv_daily_listening": 12, "total_ms": 40})
    assert rollups.refresh_rollups(conn) == {"mv_daily_listening": 12, "total_ms": 40}
    assert conn.executed == ["SELECT hub.refresh_rollups()"]
    assert conn.commits == 2  # pending work first, then the refresh
    assert "refreshed in 40 ms" in capsys.readouterr().out


def test_missing_function_before_0023_is_a_quiet_noop(capsys):
    conn = FakeConn(raise_exc=psycopg.errors.UndefinedFunction("function hub.refresh_rollups() does not exist"))
    assert rollups.refresh_rollups(conn) is None
    assert conn.rollbacks == 1
    assert "not applied" in capsys.readouterr().out


def test_other_errors_warn_but_never_raise(capsys):
    conn = FakeConn(raise_exc=RuntimeError("lock timeout"))
    assert rollups.refresh_rollups(conn) is None
    assert conn.rollbacks == 1
    assert "WARNING: rollup refresh failed" in capsys.readouterr().err


def test_aborted_transaction_is_rolled_back_not_committed():
    conn = FakeConn(result={"total_ms": 1}, status=TransactionStatus.INERROR)
    rollups.refresh_rollups(conn)
    assert conn.rollbacks == 1 and conn.commits == 1


def test_concurrent_refresh_is_skipped(capsys):
    conn = FakeConn(result='{"skipped": true}')
    assert rollups.refresh_rollups(conn) == {"skipped": True}
    assert "skipped" in capsys.readouterr().out


def test_ingest_calls_refresh_after_badges():
    src = open("scripts/ingest_spotify_recent.py").read()
    assert src.index("refresh_rollups(conn)") > src.index("Badge milestone detection/notification failed")
    assert src.index("refresh_rollups(conn)") < src.index("conn.close()")
