"""v0.88 (R8) + v0.89 (R9): send_digest keeps every digest in digest_runs (0029) for Rotor's
"This week" page, then pushes it (no mail since v0.89).

Runs on the throwaway Postgres from conftest (all migrations in number order). Never a real push
service: lib.notify's transport is a recorder, and VAPID values are fakes.
"""

from __future__ import annotations

import json

import psycopg
import pytest

from lib import notify
from lib.email_notify import EmailEventCollector, EventType, PlaylistEvent, send_digest

PID = "pl_digest_top30"


def _collector() -> EmailEventCollector:
    c = EmailEventCollector()
    c.add_event(PlaylistEvent(EventType.TRACKS_ADDED, "Top 30 last 30 days · Auto 🤖🔄", "updating", True,
                              ranked_tracks=[{"uri": "spotify:track:dA", "rank": 1, "plays_in_context": 9},
                                             {"uri": "spotify:track:dB", "rank": 2, "plays_in_context": 7},
                                             {"uri": "spotify:track:dN", "rank": 3, "plays_in_context": 3}],
                              playlist_id=PID))
    c.add_event(PlaylistEvent(EventType.TRACKS_ADDED, "Gabber · Auto 🤖🔄", "updating", False,
                              tracks=["spotify:track:dX"], playlist_id="pl_g"))
    c.add_event(PlaylistEvent(EventType.TRACKS_REMOVED, "Gabber · Auto 🤖🔄", "updating", False,
                              tracks=["spotify:track:dY"], playlist_id="pl_g"))
    c.add_event(PlaylistEvent(EventType.PLAYLIST_CREATED, "Fresh list · Auto 🤖🔄", "updating", False,
                              tracks=["spotify:track:dX"], extra={"description": "new"}))
    return c


@pytest.fixture
def conn(pg_url):
    with psycopg.connect(pg_url) as c:
        c.execute("DELETE FROM digest_runs")
        c.execute("DELETE FROM playlist_rank_history WHERE playlist_id = %s", (PID,))
        # Two earlier snapshots: the mail diffs against the 2nd-latest ("last week").
        c.execute("""INSERT INTO playlist_rank_history (playlist_id, track_uri, snapshot_at, rank) VALUES
                     (%s, 'spotify:track:dB', now() - interval '7 days', 1),
                     (%s, 'spotify:track:dA', now() - interval '7 days', 2),
                     (%s, 'spotify:track:dA', now(), 1),
                     (%s, 'spotify:track:dB', now(), 2),
                     (%s, 'spotify:track:dN', now(), 3)""", (PID,) * 5)
        c.commit()
        yield c


@pytest.fixture
def pushes(monkeypatch, conn):
    sent: list[dict] = []
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "test-not-a-key")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:test@example.invalid")
    notify.set_transport(lambda subscription_info, data, **kw: sent.append(json.loads(data)))
    conn.execute("DELETE FROM push_subscriptions")
    conn.execute("DELETE FROM push_log")
    conn.execute("DELETE FROM notification_prefs")
    conn.execute("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.invalid/1', 'k', 'a')")
    conn.commit()
    yield sent
    notify.set_transport(None)


def test_digest_is_stored_with_the_mails_sections_and_ranks_then_pushed(conn, pushes):
    assert send_digest(_collector(), conn, run_type="weekly") is True
    row = conn.execute("SELECT run_type, event_count, summary, content, delivery_status FROM digest_runs").fetchone()
    run_type, n, summary, content, status = row
    assert (run_type, n, status) == ("weekly", 4, "push_sent")
    assert summary == "1 playlist created, 2 updated."
    by = {p["name"]: p for p in content["playlists"]}
    top = by["Top 30 last 30 days · Auto 🤖🔄"]
    assert top["section"] == "updated" and top["isTop"] and top["arrows"] and top["baseline"]
    assert [(t["uri"], t["rank"], t["prev"], t["plays"]) for t in top["ranked"]] == [
        ("spotify:track:dA", 1, 2, 9), ("spotify:track:dB", 2, 1, 7), ("spotify:track:dN", 3, None, 3)]
    g = by["Gabber · Auto 🤖🔄"]
    assert (g["section"], g["added"], g["removed"]) == ("updated", ["spotify:track:dX"], ["spotify:track:dY"])
    assert by["Fresh list · Auto 🤖🔄"]["section"] == "created"
    assert content["counts"] == {"created": 1, "updated": 2, "snapshots": 0, "deleted": 0}
    assert pushes == [{"kind": "weekly_digest", "title": "Weekly refresh", "body": "1 playlist created, 2 updated.",
                       "url": "/digest", "tag": "digest-weekly"}]


def test_switched_off_digest_is_stored_but_not_pushed(conn, pushes):
    conn.execute("INSERT INTO notification_prefs (kind, enabled) VALUES ('weekly_digest', false)")
    conn.commit()
    assert send_digest(_collector(), conn, run_type="weekly") is False
    assert conn.execute("SELECT delivery_status FROM digest_runs").fetchone()[0] == "push_off"
    assert pushes == []


def test_no_device_is_recorded(conn, pushes):
    conn.execute("DELETE FROM push_subscriptions")
    conn.commit()
    assert send_digest(_collector(), conn, run_type="monthly") is False
    assert conn.execute("SELECT delivery_status FROM digest_runs").fetchone()[0] == "push_no_device"


def test_sweep_digest_stores_the_deletions_and_pushes_them(conn, pushes):
    c = EmailEventCollector()
    c.add_event(PlaylistEvent(EventType.CUSTOM_DELETED, "Party · Custom 🎧", "custom", False,
                              extra={"expires_at": "2026-11-01", "track_count": 40}))
    assert send_digest(c, conn, run_type="sweep") is True
    content = conn.execute("SELECT content FROM digest_runs WHERE run_type = 'sweep'").fetchone()[0]
    assert content["deleted"] == [{"name": "Party · Custom 🎧", "expiresAt": "2026-11-01", "trackCount": 40}]
    assert pushes[0]["kind"] == "custom_sweep"
    assert pushes[0]["body"] == "1 expired custom playlist: Party · Custom 🎧"


def test_without_0029_and_0030_the_push_still_goes_out(fake_conn, monkeypatch, capsys):
    """FakeConn has no digest_runs/notification_prefs (or transaction()): storing fails quietly,
    the switch reads as on, and the push is still attempted (VAPID unset here → 0 devices)."""
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    c = EmailEventCollector()
    c.add_event(PlaylistEvent(EventType.TRACKS_ADDED, "Gabber · Auto 🤖🔄", "updating", False, tracks=["spotify:track:dX"]))
    assert send_digest(c, fake_conn(), run_type="weekly") is False
    captured = capsys.readouterr()
    assert "WARNING: digest not stored for Rotor" in captured.err
    assert "VAPID not configured; skipping 'weekly_digest'" in captured.out


def test_content_is_json_serialisable_for_every_run_type(conn):
    from lib.digest_store import digest_content

    for rt in ("weekly", "monthly", "sweep"):
        json.dumps(digest_content(_collector().events, rt, conn))
