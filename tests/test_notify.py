"""v0.89 (R9): every former mail is a Web Push (lib/notify.py), switchable per type (0030).

Throwaway Postgres from conftest; the push transport is a recorder (never a push service).
Also scans the repository: no SMTP code and no Gmail secret is referenced anywhere any more.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import psycopg
import pytest

from lib import hub_jobs, notify, web_push

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def conn(pg_url, monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "test-not-a-key")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:test@example.invalid")
    with psycopg.connect(pg_url) as c:
        for t in ("push_subscriptions", "push_log", "notification_prefs"):
            c.execute(f"DELETE FROM {t}")
        c.execute("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.invalid/a', 'k', 'a'), ('https://push.invalid/b', 'k', 'a')")
        c.commit()
        yield c


@pytest.fixture
def sent():
    out: list[dict] = []
    notify.set_transport(lambda subscription_info, data, **kw: out.append({"to": subscription_info["endpoint"], **json.loads(data)}))
    yield out
    notify.set_transport(None)


def test_notify_reaches_every_device_and_respects_the_switch(conn, sent):
    assert notify.notify(conn, "milestone", title="🏆 100 plays", body="x — y", url="/track/x") == 2
    assert {s["to"] for s in sent} == {"https://push.invalid/a", "https://push.invalid/b"}
    conn.execute("INSERT INTO notification_prefs (kind, enabled) VALUES ('milestone', false)")
    conn.commit()
    assert notify.notify(conn, "milestone", title="t", body="b") == -1
    assert len(sent) == 2
    assert notify.enabled(conn, "snapshot") is True  # no row → on


def test_a_switched_off_type_can_still_be_tested(conn, sent):
    conn.execute("INSERT INTO notification_prefs (kind, enabled) VALUES ('weekly_digest', false)")
    conn.commit()
    assert notify.send_test(conn, "weekly_digest") == 2
    assert sent[0]["title"] == "Test · Weekly refresh" and sent[0]["tag"] == "test-weekly_digest"
    with pytest.raises(ValueError):
        notify.send_test(conn, "nope")


def test_a_push_problem_is_never_fatal(conn, monkeypatch, capsys):
    def boom(*a, **k):
        raise RuntimeError("push service down")

    monkeypatch.setattr(notify, "_send", boom)
    assert notify.notify(conn, "snapshot", title="t", body="b") == 0
    assert "WARNING: 'snapshot' push failed: RuntimeError" in capsys.readouterr().err


def test_hub_job_pushes_follow_the_switches_but_tests_always_go(conn, sent):
    push = notify.gate(lambda c, **kw: web_push.send(c, _webpush=notify._transport, **kw))
    conn.execute("INSERT INTO notification_prefs (kind, enabled) VALUES ('daily_pick', false)")
    conn.commit()
    assert push(conn, kind="daily_pick", title="Today's pick is ready", body="b", url="/home") == 0
    assert push(conn, kind="test", title="Rotor", body="b", url="/settings") == 2
    assert push(conn, kind="daily_pick", title="Test · x", body="b", url="/home", tag="test-daily_pick") == 2


def test_push_test_job_sends_the_types_sample(conn, sent):
    ctx = {"push": notify.gate(lambda c, **kw: web_push.send(c, _webpush=notify._transport, **kw))}
    assert hub_jobs._push_test(conn, {"kind": "ingest_alert"}, ctx) == {"delivered": 2, "kind": "ingest_alert"}
    assert sent[-1]["kind"] == "ingest_alert" and sent[-1]["url"] == "/settings/health"
    with pytest.raises(hub_jobs.JobError):
        hub_jobs._push_test(conn, {"kind": "smtp"}, ctx)


def test_milestone_and_badges_push_once_per_badge(conn, sent):
    from lib.artist_badges import award_artist_badge
    from lib.badges import BadgeAwardCollector, award_special_badge, record_and_notify_milestone, send_badge_digest

    uri = "spotify:track:notify0000000000000001"
    conn.execute("DELETE FROM badge_events WHERE entity_id IN (%s, 'notifyartist000000001')", (uri,))
    conn.execute("INSERT INTO spotify_plays (played_at, ms_played, track_uri, track_name, artist_name) VALUES (now(), 1000, %s, 'Song', 'Band')", (uri,))
    conn.commit()
    assert record_and_notify_milestone(conn, uri, 100) is True
    assert record_and_notify_milestone(conn, uri, 100) is False  # already awarded: nothing sent
    m = [s for s in sent if s["kind"] == "milestone"]
    assert len(m) == 2 and m[0]["title"] == "🏆 100 plays" and m[0]["body"] == "Song — Band"
    assert m[0]["url"] == "/track/spotify%3Atrack%3Anotify0000000000000001"

    assert award_special_badge(conn, uri, "comeback", {"window": "2026-10"}) is True
    sp = [s for s in sent if s["kind"] == "special_badge"]
    assert sp[0]["title"].endswith("Comeback") and sp[0]["body"] == "Song — Band · 2026-10"
    assert award_special_badge(conn, uri, "played_on_day_one", {}) is True  # silent: row only
    assert not [s for s in sent if "day one" in s["title"].lower()]

    assert award_artist_badge(conn, "notifyartist000000001", "top_1st_artist_month", {"window": "2026-10"}) is True
    ab = [s for s in sent if s["kind"] == "artist_badge"]
    assert "#1 artist of the month" in ab[0]["title"] and ab[0]["url"] == "/artist/notifyartist000000001"

    col = BadgeAwardCollector()
    col.add(uri, "on_repeat", {})
    col.add_artist("notifyartist000000001", "dynasty", {})
    assert send_badge_digest(conn, col) is True
    d = [s for s in sent if s["kind"] == "badge_digest"][0]
    assert d["title"] == "2 new badges" and d["url"] == "/stats/badges"
    assert d["body"].startswith("On repeat (5+ loop sessions) · Song")


def test_snapshot_push(conn, sent):
    from lib.snapshot_notify import build_and_send_snapshot_notification

    ranked = [{"track_uri": "spotify:track:x", "track_name": "Top Song", "artist_display": "Band", "plays_in_period": 31}]
    assert build_and_send_snapshot_notification(conn, "month", "October 2026", "Top 25 · October 2026 · Auto 🤖📸", ranked, "PL1") is True
    assert sent[-1] == {"to": "https://push.invalid/b", "kind": "snapshot", "title": "Snapshot ready: October 2026",
                        "body": "#1 of 1: Top Song — Band (31 plays)", "url": "/playlist/PL1", "tag": "snapshot"}
    assert build_and_send_snapshot_notification(conn, "month", "October 2026", "Top 25 · October 2026 · Auto 🤖📸", ranked, "PL1") is False  # deduped


def test_freshness_monitor_fails_the_run_when_nobody_was_told(conn, sent, monkeypatch):
    from datetime import timedelta

    from scripts import check_ingest_freshness as cf

    newest = conn.execute("SELECT max(played_at) FROM spotify_plays").fetchone()[0]
    monkeypatch.setattr(cf, "fetch_spotify_latest", lambda: newest + timedelta(hours=5))
    assert cf._check(conn, dry_run=False) == 0  # pushed → GitHub annotation only
    assert sent[-1]["kind"] == "ingest_alert" and sent[-1]["title"].startswith("Ingest stale: 5h")
    conn.execute("DELETE FROM push_subscriptions")
    conn.commit()
    assert cf._check(conn, dry_run=False) == 1  # nobody reached → fail → GitHub's own notification


def test_every_kind_has_a_label_and_sample():
    for kind, (label, title, body, url) in notify.KINDS.items():
        assert label and title and body and url.startswith("/"), kind


def test_no_smtp_or_gmail_left_in_code_or_workflows():
    offenders = []
    for path in [*ROOT.glob("lib/**/*.py"), *ROOT.glob("scripts/*.py"), *ROOT.glob("app.py"), *ROOT.glob("views/*.py"),
                 *ROOT.glob(".github/workflows/*.yml"), ROOT / ".env.example", ROOT / "hub/.env.example"]:
        if not path.exists():
            continue
        text = path.read_text()
        if re.search(r"\bsmtplib\b|smtp\.gmail\.com|\bGMAIL_[A-Z_]+|\bEMAIL_RECIPIENT\b|MUSIC_TRACKER_EMAIL_DRY_RUN", text):
            offenders.append(str(path.relative_to(ROOT)))
    assert offenders == []


def test_scheduled_workflows_that_notify_have_the_vapid_secrets_and_no_duplicate_env_keys():
    wf = ROOT / ".github/workflows"
    for f in wf.glob("*.yml"):
        lines = f.read_text().split("\n")
        # every `env:` block: no key twice
        for i, line in enumerate(lines):
            if line.strip() == "env:":
                indent = len(line) - len(line.lstrip()) + 2
                keys = []
                for nxt in lines[i + 1:]:
                    if not nxt.strip():
                        continue
                    ind = len(nxt) - len(nxt.lstrip())
                    if ind < indent:
                        break
                    if ind == indent and ":" in nxt:
                        keys.append(nxt.strip().split(":")[0])
                assert len(keys) == len(set(keys)), f"duplicate env key in {f.name} line {i + 1}: {keys}"
    text = (wf / "scheduled-ingest.yml").read_text()
    for script in ("update_managed_playlists.py", "ingest_spotify_recent.py", "sweep_expired_custom_playlists.py",
                   "create_snapshots.py", "monthly_playlist_refresh.py"):
        rest = text[text.index(script):]
        nxt = re.search(r"\n  [a-z][\w-]*:\n", rest)  # the next job
        block = rest[: nxt.start()] if nxt else rest
        assert "VAPID_PRIVATE_KEY: ${{ secrets.VAPID_PRIVATE_KEY }}" in block, script
        assert "VAPID_SUBJECT: ${{ secrets.VAPID_SUBJECT }}" in block, script
    assert "VAPID_PRIVATE_KEY" in (wf / "ingest-monitor.yml").read_text()
