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


# ── Throwaway Postgres 16 (v0.86) ────────────────────────────────────────────
# One initdb'd cluster per test session, on a free port in a temp dir, with every migration in
# migrations/ applied in number order. Never the real database. Tests that use it are skipped
# when no Postgres ≥ 16 binaries are found (brew install postgresql@16, or set PG_BIN).

def _pg_bin():
    import os
    import re
    import subprocess

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


@pytest.fixture(scope="session")
def pg_url(tmp_path_factory):
    import os
    import shutil
    import socket
    import subprocess

    import psycopg

    pg_bin = _pg_bin()
    if pg_bin is None:
        pytest.skip("no Postgres 16+ binaries (brew install postgresql@16, or set PG_BIN)")
    data = tmp_path_factory.mktemp("pg") / "data"
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "LC_ALL": "en_US.UTF-8", "LANG": "en_US.UTF-8"}
    subprocess.run([pg_bin / "initdb", "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C",
                    "-c", "timezone=UTC"], check=True, capture_output=True, env=env)
    subprocess.run([pg_bin / "pg_ctl", "-D", data, "-o", f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''",
                    "-l", data.parent / "pg.log", "-w", "start"], check=True, capture_output=True, env=env)
    url = f"postgresql://postgres@127.0.0.1:{port}/postgres"
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            # 0033 (drop scrobbles) refuses without the archive's row count; this throwaway DB's is empty.
            conn.execute("SET rotor.scrobbles_archived_rows = '0'")
            for f in sorted((ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")):
                conn.execute(f.read_text())
        yield url
    finally:
        subprocess.run([pg_bin / "pg_ctl", "-D", data, "-m", "fast", "stop"], capture_output=True, env=env)
        shutil.rmtree(data, ignore_errors=True)
