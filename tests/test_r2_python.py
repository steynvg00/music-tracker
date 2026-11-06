"""R2 Python: single-playlist refresh guard, Web Push, shared preview function, rules mapping."""
import psycopg
import pytest

from lib import managed_refresh as mr
from lib import rules_catalog, temporary_playlists, web_push
from tests.conftest import FakeConn

PL = "37i9dQZF1DXcBWIGoYBM5M"


class WriteRecordingSp:
    """Spotipy stand-in: answers reads, records every write."""

    def __init__(self, name, owner="me"):
        self.name = name
        self.owner = owner
        self.writes = []

    def current_user(self):
        return {"id": "me"}

    def playlist(self, pid, fields=None):
        return {"id": pid, "name": self.name, "owner": {"id": self.owner}}

    def __getattr__(self, attr):  # any other call (replace/add/create/change) counts as a write
        def record(*a, **k):
            self.writes.append(attr)
        return record


@pytest.mark.parametrize("name,owner,reason", [
    ("Road trip Italy 2022", "me", "no_managed_suffix"),
    ("Gym raw · Custom 🎧", "me", "custom"),
    ("x · Auto 🤖🔄 (copy)", "me", "no_managed_suffix"),
    ("Top 30 last 30 days · Auto 🤖🔄", "someone-else", "not_owned"),
])
def test_refresh_one_refuses_before_any_write(name, owner, reason):
    sp = WriteRecordingSp(name, owner)
    with pytest.raises(mr.ReadOnlyPlaylist) as e:
        mr.refresh_one(FakeConn(), sp, PL)
    assert e.value.reason == reason
    assert sp.writes == []


def test_refresh_one_pins_the_requested_playlist(monkeypatch):
    sp = WriteRecordingSp("Top 30 last 30 days · Auto 🤖🔄")
    seen = {}

    def fake_update(sp_, conn, me, definition, cache, collector=None):
        seen.update(cache=cache, me=me, collector=collector, suffix=definition.suffix)
        return {"name": "Top 30 last 30 days · Auto 🤖🔄", "playlist_id": PL, "track_count": 30, "action": "updated"}

    monkeypatch.setattr(mr.playlists, "update_managed_playlist", fake_update)
    monkeypatch.setattr(mr.playlists, "get_managed_playlists", lambda conn, sp: list(mr.playlists.STATIC_PLAYLISTS))
    mr.playlists._playlist_settings_cache = {"stale": {}}
    r = mr.refresh_one(FakeConn(), sp, PL)
    assert r["track_count"] == 30
    assert seen == {"cache": {"Top 30 last 30 days · Auto 🤖🔄": PL}, "me": "me", "collector": None,
                    "suffix": "Top 30 last 30 days"}
    assert mr.playlists._playlist_settings_cache is None  # order prefs read fresh


def test_refresh_one_rejects_a_drifted_result(monkeypatch):
    sp = WriteRecordingSp("Top 30 last 30 days · Auto 🤖🔄")
    monkeypatch.setattr(mr.playlists, "get_managed_playlists", lambda conn, sp: list(mr.playlists.STATIC_PLAYLISTS))
    monkeypatch.setattr(mr.playlists, "update_managed_playlist",
                        lambda *a, **k: {"playlist_id": "Z" * 22, "name": "", "track_count": 0, "action": ""})
    with pytest.raises(RuntimeError):
        mr.refresh_one(FakeConn(), sp, PL)


def test_refresh_snapshot_requests_force_refresh(monkeypatch):
    sp = WriteRecordingSp("Top 100 · 2025 · Auto 🤖📸")

    class D:
        suffix, legacy_names = "Top 100 · 2025", []
    monkeypatch.setattr(mr, "find_definition", lambda conn, sp, name, kind: D())
    monkeypatch.setattr(mr.playlists, "update_managed_playlist",
                        lambda *a, **k: {"playlist_id": PL, "name": "x", "track_count": 100, "action": "updated"})
    conn = FakeConn()
    mr.refresh_one(conn, sp, PL)
    assert conn.sql_matching("force_refresh_requested_at")


def test_unknown_definition_raises_lookup(monkeypatch):
    sp = WriteRecordingSp("Not a real one · Auto 🤖🔄")
    monkeypatch.setattr(mr.playlists, "get_managed_playlists", lambda conn, sp: list(mr.playlists.STATIC_PLAYLISTS))
    with pytest.raises(LookupError):
        mr.refresh_one(FakeConn(), sp, PL)
    assert sp.writes == []


# ── Web Push ──

class Resp:
    def __init__(self, status):
        self.status_code = status


def _push_conn(subs, dedupe_new=True):
    def respond(sql, params):
        if sql.lstrip().startswith("INSERT INTO push_log"):
            return [("k",)] if dedupe_new else []
        if "FROM push_subscriptions" in sql:
            return subs
        return []
    return FakeConn(respond)


def test_push_skips_without_vapid(monkeypatch):
    monkeypatch.delenv("VAPID_PRIVATE_KEY", raising=False)
    assert web_push.send(_push_conn([("e", "p", "a")]), kind="x", title="t", body="b",
                         _webpush=lambda **k: pytest.fail("must not send")) == 0


def test_push_sends_dedupes_and_prunes(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "k")
    monkeypatch.setenv("VAPID_SUBJECT", "https://rotor.example")
    sent = []

    def fake(subscription_info, data, vapid_private_key, vapid_claims, ttl, timeout):
        sent.append((subscription_info["endpoint"], data, vapid_claims))
        if subscription_info["endpoint"] == "gone":
            raise web_push.WebPushException("gone", response=Resp(410))
    conn = _push_conn([("ok", "p", "a"), ("gone", "p", "a")])
    assert web_push.send(conn, kind="job", title="Rotor", body="done", url="/x", dedupe_key="k1", _webpush=fake) == 1
    assert '"title": "Rotor"' in sent[0][1] and sent[0][2] == {"sub": "https://rotor.example"}
    assert conn.sql_matching("DELETE FROM push_subscriptions")
    again = _push_conn([("ok", "p", "a")], dedupe_new=False)
    assert web_push.send(again, kind="job", title="t", body="b", dedupe_key="k1",
                         _webpush=lambda **k: pytest.fail("deduped")) == 0


# ── shared preview function ──

def test_preview_uses_the_sql_function():
    conn = FakeConn(lambda sql, p: [("u", "n", "a", "al", 3, None, 2020, "2020-01-01")])
    rows = temporary_playlists.query_temp_playlist_tracks(conn, artists=["Da Tweekaz"], min_plays=5, liked_only=True)
    (sql, params), = conn.sql_matching("hub.custom_playlist_preview")
    assert '"artists": ["Da Tweekaz"]' in params[0] and '"liked_only": true' in params[0]
    assert rows[0]["plays"] == 3 and rows[0]["release_date"] == "2020-01-01"


def test_preview_falls_back_before_migration_0022():
    def respond(sql, params):
        if "hub.custom_playlist_preview" in sql:
            raise psycopg.errors.UndefinedFunction("function hub.custom_playlist_preview does not exist")
        return [("u", "n", "a", "al", 3, None, 2020, "2020-01-01")]
    conn = FakeConn(respond)
    rows = temporary_playlists.query_temp_playlist_tracks(conn, sort_order="plays_desc")
    assert conn.rollbacks == 1 and rows[0]["track_uri"] == "u"
    assert conn.sql_matching("WITH per_track AS")


def test_preview_filters_shape_matches_hub():
    f = temporary_playlists.preview_filters(artists=None, max_tracks=50000, sort_order="weird")
    assert f == {"artists": [], "release_year_min": None, "release_year_max": None, "discovery_year_min": None,
                 "discovery_year_max": None, "min_plays": None, "max_tracks": 10000, "liked_only": False,
                 "sort_order": "plays_desc"}


# ── rules catalog ──

def test_category_mapping_incl_decades_and_legacy():
    mapping = {"Top 30 last 30 days · Auto 🤖🔄": "top_recent_30d", "Top 50 last 30 days · Auto 🤖🔄": "top_recent_30d"}
    assert rules_catalog.category_for("Top 50 last 30 days · Auto 🤖🔄", mapping) == "top_recent_30d"
    assert rules_catalog.category_for("Top 100 · 2020s · Auto 🤖📸", mapping) == "snapshot_decade"
    assert rules_catalog.category_for("Road trip", mapping) is None
