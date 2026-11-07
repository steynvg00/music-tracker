"""0025_mixes.sql (R5) is safe to apply AFTER 0027 — the production order, since 0027 went live
first — and in plain number order. Throwaway Postgres 16 (conftest.pg_url); never the real DB."""
from pathlib import Path

import psycopg
import pytest

from lib import hub_jobs

ROOT = Path(__file__).resolve().parent.parent
MIG = sorted((ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
ALL_KINDS = ("reseed_daily_pick", "refresh_managed", "push_test", "mix_relay", "wrapped_build")
# What 0025 said before this fix: four kinds, no 'wrapped_build'.
OLD_0025_CHECK = """ALTER TABLE hub_jobs DROP CONSTRAINT hub_jobs_kind_check,
  ADD CONSTRAINT hub_jobs_kind_check CHECK (kind IN ('reseed_daily_pick', 'refresh_managed', 'push_test', 'mix_relay'))"""


def kinds_allowed(conn) -> set[str]:
    out = set()
    for k in ALL_KINDS + ("not_a_kind",):
        try:
            with conn.transaction():
                conn.execute("INSERT INTO hub_jobs (kind) VALUES (%s)", (k,))
                raise _Rollback
        except _Rollback:
            out.add(k)
        except psycopg.errors.CheckViolation:
            pass
    return out


class _Rollback(Exception):
    pass


@pytest.fixture
def fresh_db(pg_url):
    """An empty database next to the session one, dropped afterwards."""
    with psycopg.connect(pg_url, autocommit=True) as admin:
        admin.execute("DROP DATABASE IF EXISTS mig0025")
        admin.execute("CREATE DATABASE mig0025")
    url = pg_url.rsplit("/", 1)[0] + "/mig0025"
    yield url
    with psycopg.connect(pg_url, autocommit=True) as admin:
        admin.execute("DROP DATABASE IF EXISTS mig0025 WITH (FORCE)")


def test_number_order_allows_every_kind(pg_url):
    with psycopg.connect(pg_url) as conn:
        assert kinds_allowed(conn) == set(ALL_KINDS)
        assert set(hub_jobs.KINDS) == set(ALL_KINDS)


def test_0025_applied_after_0027_keeps_wrapped_build_and_its_rows(fresh_db):
    mixes = next(f for f in MIG if f.name.startswith("0025_"))
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        for f in MIG:
            if f is not mixes:
                conn.execute(f.read_text())           # production: everything but 0025, incl. 0027
        assert conn.execute("SELECT count(*) FROM migrations_applied WHERE number = 27").fetchone()[0] == 1
        conn.execute("INSERT INTO hub_jobs (kind, payload, status) VALUES ('wrapped_build', '{\"year\": 2025}', 'done')")

        # The old statement fails here (the bug this fixes).
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                conn.execute(OLD_0025_CHECK)

        conn.execute(mixes.read_text())               # the fixed 0025, last
        assert conn.execute("SELECT count(*) FROM hub_jobs WHERE kind = 'wrapped_build'").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM migrations_applied WHERE number = 25").fetchone()[0] == 1
        for t in ("mixes", "mix_items", "playback_sessions", "handoff_events"):
            assert conn.execute("SELECT to_regclass(%s)", (t,)).fetchone()[0] == t
    with psycopg.connect(fresh_db) as conn:
        assert kinds_allowed(conn) == set(ALL_KINDS)


def test_0025_and_0027_list_the_same_kinds():
    text = {f.name[:4]: f.read_text() for f in MIG}
    lists = {n: " ".join(text[n].split("CHECK (kind IN (")[1].split(")")[0].split()) for n in ("0025", "0027")}
    assert lists["0025"] == lists["0027"]
    for k in ALL_KINDS:
        assert f"'{k}'" in lists["0025"]
