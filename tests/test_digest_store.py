"""v0.88 (R8): send_digest keeps every digest in digest_runs (0029) for Rotor's "This week" page.

Runs on the throwaway Postgres from conftest (all migrations in number order). Never real mail:
MUSIC_TRACKER_EMAIL_DRY_RUN=1, or the mail function is replaced by a fake that raises.
"""

from __future__ import annotations

import json

import psycopg
import pytest

import lib.email_notify as en
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


def test_dry_run_digest_is_stored_with_the_mails_sections_and_ranks(conn, monkeypatch, capsys):
    monkeypatch.setenv("MUSIC_TRACKER_EMAIL_DRY_RUN", "1")
    assert send_digest(_collector(), conn, run_type="weekly") is True
    row = conn.execute("SELECT run_type, event_count, summary, content, delivery_status FROM digest_runs").fetchone()
    run_type, n, summary, content, status = row
    assert (run_type, n, status) == ("weekly", 4, "mail_dry_run")
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
    assert "music-tracker: 4 playlist updates" in capsys.readouterr().out  # the mail itself still ran


def test_a_failing_mail_keeps_the_digest_and_records_the_error(conn, monkeypatch):
    monkeypatch.delenv("MUSIC_TRACKER_EMAIL_DRY_RUN", raising=False)

    def boom(*a, **k):
        raise en.smtplib.SMTPServerDisconnected("Connection unexpectedly closed")

    monkeypatch.setattr(en, "_send_digest_mail", boom)
    with pytest.raises(en.smtplib.SMTPServerDisconnected):
        send_digest(_collector(), conn, run_type="weekly")
    status, err = conn.execute("SELECT delivery_status, delivery_error FROM digest_runs").fetchone()
    assert status == "mail_failed"
    assert err == "SMTPServerDisconnected: Connection unexpectedly closed"


def test_sweep_digest_stores_the_deletions(conn, monkeypatch):
    monkeypatch.setenv("MUSIC_TRACKER_EMAIL_DRY_RUN", "1")
    c = EmailEventCollector()
    c.add_event(PlaylistEvent(EventType.CUSTOM_DELETED, "Party · Custom 🎧", "custom", False,
                              extra={"expires_at": "2026-11-01", "track_count": 40}))
    assert send_digest(c, conn, run_type="sweep") is True
    content = conn.execute("SELECT content FROM digest_runs WHERE run_type = 'sweep'").fetchone()[0]
    assert content["deleted"] == [{"name": "Party · Custom 🎧", "expiresAt": "2026-11-01", "trackCount": 40}]


def test_without_0029_the_mail_still_goes_out(fake_conn, monkeypatch, capsys):
    """FakeConn has no digest_runs (or transaction()): storing fails quietly, the mail is unchanged."""
    monkeypatch.setenv("MUSIC_TRACKER_EMAIL_DRY_RUN", "1")
    c = EmailEventCollector()
    c.add_event(PlaylistEvent(EventType.TRACKS_ADDED, "Gabber · Auto 🤖🔄", "updating", False, tracks=["spotify:track:dX"]))
    assert send_digest(c, fake_conn(), run_type="weekly") is True
    captured = capsys.readouterr()
    assert "WARNING: digest not stored for Rotor" in captured.err
    assert "music-tracker: 1 playlist updates" in captured.out


def test_content_is_json_serialisable_for_every_run_type(conn):
    from lib.digest_store import digest_content

    for rt in ("weekly", "monthly", "sweep"):
        json.dumps(digest_content(_collector().events, rt, conn))
