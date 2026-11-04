import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeCursor:
    """Records SQL; answers SELECTs from a queue of canned results."""

    def __init__(self, conn):
        self.conn = conn
        self.rowcount = 0
        self._rows: list = []

    def execute(self, sql, params=None):
        self.conn.executed.append((" ".join(sql.split()), params))
        handler = self.conn.responder
        self._rows = list(handler(sql, params) or []) if handler else []
        self.rowcount = len(self._rows)

    def executemany(self, sql, seq):
        for params in seq:
            self.conn.executed.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self, responder=None):
        self.executed: list[tuple[str, object]] = []
        self.responder = responder
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True

    def sql_matching(self, fragment: str):
        return [(s, p) for s, p in self.executed if fragment in s]


@pytest.fixture
def fake_conn():
    return FakeConn
