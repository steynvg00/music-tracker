from datetime import date, datetime, timezone

import pytest

from lib import hub_jobs
from tests.conftest import FakeConn

JOB = "0b5e2c1a-7f1d-4c2e-9a3b-123456789abc"
PL = "37i9dQZF1DXcBWIGoYBM5M"


def conn_with(claim_row):
    """FakeConn whose claim UPDATE returns claim_row (or nothing)."""
    def respond(sql, params):
        if "SET status = 'running'" in sql:
            return [claim_row] if claim_row else []
        return []
    return FakeConn(respond)


class PushSpy:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def __call__(self, conn, **kw):
        self.calls.append(kw)
        if self.fail:
            raise RuntimeError("push service down")
        return 1


def test_is_job_id():
    assert hub_jobs.is_job_id(JOB)
    assert not hub_jobs.is_job_id("1; rm -rf /")
    assert not hub_jobs.is_job_id(None)


def test_claim_is_atomic_and_idempotent():
    conn = conn_with(None)
    assert hub_jobs.claim(conn, JOB) is None
    (sql, params), = conn.sql_matching("SET status = 'running'")
    assert "WHERE id = %s AND status = 'queued'" in sql and "attempts = attempts + 1" in sql


def test_skipped_when_not_queued_runs_nothing():
    conn = conn_with(None)
    push = PushSpy()
    assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: pytest.fail("no Spotify"), push=push) == "skipped"
    assert not conn.sql_matching("status = 'done'") and not push.calls


def test_reseed_success_finishes_and_notifies(monkeypatch):
    class R:
        status, deck, start_rank = "reseeded", [1, 2, 3, 4, 5], 6
    seen = {}
    monkeypatch.setattr(hub_jobs.daily_picks, "generate", lambda conn, day, reseed: seen.update(day=day, reseed=reseed) or R())
    conn = conn_with((JOB, "reseed_daily_pick", {"date": "2026-11-05"}, 1, "reseed:2026-11-05"))
    push = PushSpy()
    assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: None, push=push) == "done"
    assert seen == {"day": date(2026, 11, 5), "reseed": True}
    (sql, params), = conn.sql_matching("SET status = 'done'")
    assert '"added": 5' in params[0]
    assert push.calls[0]["body"] == "5 fresh picks are ready" and push.calls[0]["url"] == "/home"


def test_failure_lands_on_the_row_with_a_readable_error(monkeypatch):
    import lib.managed_refresh as mr

    def boom(conn, sp, pid):
        raise mr.ReadOnlyPlaylist(pid, "no_managed_suffix")
    monkeypatch.setattr(mr, "refresh_one", boom)
    conn = conn_with((JOB, "refresh_managed", {"playlist_id": PL}, 2, f"refresh:{PL}"))
    push = PushSpy()
    assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: object(), push=push) == "failed"
    (sql, params), = conn.sql_matching("SET status = 'failed'")
    assert "no_managed_suffix" in params[0]
    assert conn.rollbacks >= 1
    assert push.calls[0]["body"].startswith("A Rotor job failed")


def test_bad_payload_and_unknown_kind_fail():
    for row in [
        (JOB, "refresh_managed", {"playlist_id": "../../me"}, 1, None),
        (JOB, "reseed_daily_pick", {"date": "tomorrow"}, 1, None),
        (JOB, "drop_tables", {}, 1, None),
    ]:
        conn = conn_with(row)
        assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: None, push=PushSpy()) == "failed"


def test_notification_failure_does_not_change_the_outcome(monkeypatch):
    class R:
        status, deck, start_rank = "reseeded", [1], 6
    monkeypatch.setattr(hub_jobs.daily_picks, "generate", lambda *a, **k: R())
    conn = conn_with((JOB, "reseed_daily_pick", {"date": "2026-11-05"}, 1, None))
    assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: None, push=PushSpy(fail=True)) == "done"


def test_push_test_needs_vapid(monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    conn = conn_with((JOB, "push_test", {}, 1, None))
    assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: None, push=PushSpy()) == "failed"
    (sql, params), = conn.sql_matching("SET status = 'failed'")
    assert "VAPID" in params[0]


def test_retry_runs_again_after_requeue(monkeypatch):
    # The hub re-queues a failed job; the next claim increments attempts and runs it.
    class R:
        status, deck, start_rank = "reseeded", [1], 6
    monkeypatch.setattr(hub_jobs.daily_picks, "generate", lambda *a, **k: R())
    conn = conn_with((JOB, "reseed_daily_pick", {"date": "2026-11-05"}, 2, None))
    assert hub_jobs.run_job(conn, JOB, sp_factory=lambda: None, push=PushSpy()) == "done"


def test_sweep_stale_marks_queued_and_running():
    conn = FakeConn(lambda sql, p: [("a",), ("b",)] if "stale" in sql else [])
    assert hub_jobs.sweep_stale(conn) == 2
    (sql, params), = conn.sql_matching("stale: no runner")
    assert params == (hub_jobs.STALE_QUEUED, hub_jobs.STALE_RUNNING)


def test_pending_snapshot_rebuilds_only_snapshots():
    rows = [("A" * 22, "Top 25 · March 2021 · Auto 🤖📸"), ("B" * 22, "Top 30 last 30 days · Auto 🤖🔄"),
            ("C" * 22, "Road trip")]
    conn = FakeConn(lambda sql, p: rows if "force_refresh_requested_at" in sql else [])
    assert hub_jobs.pending_snapshot_rebuilds(conn) == [("A" * 22, "Top 25 · March 2021 · Auto 🤖📸")]


def test_token_notices_thresholds():
    auth = datetime(2026, 5, 21, tzinfo=timezone.utc)  # expires 2026-11-21
    conn = FakeConn(lambda sql, p: [("hub", auth, None), ("cron", auth, "invalid_grant")])
    assert hub_jobs.token_notices(conn, date(2026, 11, 1)) == [
        {"key": "token:cron:2026-11-21:dead", "body": "The crons' Spotify token stopped working. Reconnect in Settings."}
    ]
    n14 = hub_jobs.token_notices(FakeConn(lambda s, p: [("hub", auth, None)]), date(2026, 11, 7))
    assert n14[0]["key"] == "token:hub:2026-11-21:14" and "14 days" in n14[0]["body"]
    n3 = hub_jobs.token_notices(FakeConn(lambda s, p: [("hub", auth, None)]), date(2026, 11, 19))
    assert n3[0]["key"] == "token:hub:2026-11-21:3"


def test_add_months_matches_hub_rule():
    assert hub_jobs._add_months(datetime(2026, 8, 31), 6) == datetime(2027, 2, 28)


def test_run_daily_collects_step_errors(monkeypatch):
    import lib.rules_catalog as rc
    monkeypatch.setattr(rc, "export_rules_catalog", lambda conn: (_ for _ in ()).throw(RuntimeError("boom")))

    class R:
        status = "exists"
    monkeypatch.setattr(hub_jobs.daily_picks, "generate", lambda conn, day: R())

    def respond(sql, params):
        if "SELECT c.title" in sql:
            return [("Forgotten gems",)]
        if "FROM wrapped_snapshots" in sql:  # v0.86: last year's Wrapped is already frozen
            return [(1,)]
        return []
    conn = FakeConn(respond)
    push = PushSpy()
    summary = hub_jobs.run_daily(conn, sp_factory=lambda: pytest.fail("no snapshot pending"), push=push,
                                 today=date(2026, 11, 5))
    assert summary["wrapped"] == {"year": 2025, "created": False}
    assert summary["daily_pick"] == {"generated": "exists", "notified": 1}
    assert push.calls[0]["dedupe_key"] == "daily:2026-11-05" and push.calls[0]["body"] == "Forgotten gems"
    assert summary["errors"] == ["rules_catalog: RuntimeError: boom"]
