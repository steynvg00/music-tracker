import pytest

from lib import playlist_mirror as pm
from lib.playlists import SNAPSHOT_NAME_SUFFIX, UPDATING_NAME_SUFFIX
from lib.temporary_playlists import CUSTOM_NAME_SUFFIX
from tests.conftest import FakeConn, load_fixture

CASES = load_fixture("managed_names.json")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[repr(c["name"]) for c in CASES])
def test_managed_kind_matches_shared_fixture(case):
    assert pm.managed_kind(case["name"]) == case["kind"]


def test_suffixes_are_the_ones_the_crons_write():
    assert set(pm.MANAGED_SUFFIXES) == {UPDATING_NAME_SUFFIX, SNAPSHOT_NAME_SUFFIX, CUSTOM_NAME_SUFFIX}


def _pl(pid, name, owner="me", collab=False, total=10, key="tracks", snapshot="s1", images=None):
    return {"id": pid, "name": name, "owner": {"id": owner, "display_name": owner.title()},
            "collaborative": collab, "public": False, "snapshot_id": snapshot,
            key: {"total": total}, "images": images if images is not None else [{"url": f"https://i/{pid}"}]}


def test_parse_playlist_owned_and_followed():
    own = pm.parse_playlist(_pl("a", "Top 30 last 30 days · Auto 🤖🔄"), "me")
    assert own["is_owned"] and own["managed_kind"] == "auto_updating"
    assert own["track_count"] == 10 and own["image_url"] == "https://i/a"
    # A followed playlist with a managed-looking name is still not managed.
    fol = pm.parse_playlist(_pl("b", "Copy · Custom 🎧", owner="someone"), "me")
    assert not fol["is_owned"] and fol["managed_kind"] is None


def test_parse_playlist_accepts_feb_2026_items_key():
    row = pm.parse_playlist(_pl("c", "x", key="items", total=42, images=[]), "me")
    assert row["track_count"] == 42 and row["image_url"] is None


def test_parse_item_track_and_item_keys():
    a = pm.parse_item({"added_at": "2026-01-01T00:00:00Z",
                       "track": {"uri": "spotify:track:1", "name": "T", "duration_ms": 1000,
                                 "artists": [{"name": "A"}, {"name": "B"}]}})
    assert a == {"track_uri": "spotify:track:1", "track_name": "T", "artist_name": "A, B",
                 "duration_ms": 1000, "added_at": "2026-01-01T00:00:00Z"}
    assert pm.parse_item({"item": {"uri": "spotify:episode:9"}})["track_uri"] == "spotify:episode:9"
    assert pm.parse_item({"track": None}) is None


def _row(name, owned=True, collab=False):
    return {"name": name, "is_owned": owned, "is_collab": collab,
            "managed_kind": pm.managed_kind(name) if owned else None}


def test_wants_items_policy():
    assert pm.wants_items(_row("Road trip"))
    assert pm.wants_items(_row("Top 25 · March 2021 · Auto 🤖📸"))
    assert pm.wants_items(_row("Gym · Custom 🎧"))
    assert pm.wants_items(_row("Missed new tracks · other artists · Auto 🤖🔄"))
    assert not pm.wants_items(_row("100+ plays · Auto 🤖🔄"))
    assert pm.wants_items(_row("100+ plays · Auto 🤖🔄"), all_items=True)
    assert not pm.wants_items(_row("Followed", owned=False))
    assert pm.wants_items(_row("Shared", owned=False, collab=True))


class FakeSp:
    def __init__(self, playlists, items):
        self.playlists = playlists
        self.items = items
        self.item_calls: list[str] = []

    def current_user(self):
        return {"id": "me"}

    def current_user_playlists(self, limit, offset):
        page = self.playlists[offset:offset + limit]
        return {"items": page, "next": "more" if offset + limit < len(self.playlists) else None}

    def playlist_items(self, playlist_id, limit, offset, fields):
        self.item_calls.append(playlist_id)
        if playlist_id not in self.items:
            raise RuntimeError("403")
        return {"items": [{"track": {"uri": u, "name": u, "artists": []}} for u in self.items[playlist_id]],
                "next": None}

    # Anything that writes to Spotify would show up here as an AttributeError.


def _responder(previous):
    def respond(sql, params):
        if sql.strip().startswith("SELECT now()"):
            return [("RUN",)]
        if "SELECT playlist_id, items_snapshot_id" in sql:
            return list(previous.items())
        return []
    return respond


def test_sync_mirror_upserts_removes_and_fetches_changed_items(monkeypatch):
    monkeypatch.setattr(pm, "_PAGE_SLEEP_S", 0)
    playlists = [_pl(f"p{i}", f"Auto {i} · Auto 🤖🔄") for i in range(55)]
    playlists += [_pl("own", "Road trip", snapshot="s2"), _pl("same", "Old mix", snapshot="s1"),
                  _pl("snap", "Top 25 · March 2021 · Auto 🤖📸", snapshot="s9"),
                  _pl("fol", "Followed", owner="x")]
    sp = FakeSp(playlists, {"own": ["spotify:track:1", "spotify:track:2"]})
    conn = FakeConn(_responder({"own": "s1", "same": "s1", "gone": "s0"}))

    r = pm.sync_mirror(conn, sp, sleep_s=0)

    assert r.listed == 59 and r.upserted == 59
    assert len(conn.sql_matching("INSERT INTO spotify_playlists")) == 59
    assert conn.sql_matching("UPDATE spotify_playlists SET removed_at")
    assert "NOT is_collab" in conn.sql_matching("UPDATE spotify_playlists SET removed_at")[0][0]
    # Only changed, item-worthy playlists are read: 'own' (s1 → s2) and 'snap' (new); not
    # 'same' (unchanged), not the auto-updating ones, not the followed one.
    assert sp.item_calls == ["own", "snap"]
    assert r.items_synced == 1 and r.items_failed == ["snap"]
    inserts = conn.sql_matching("INSERT INTO spotify_playlist_items")
    assert [p[:3] for _, p in inserts] == [("own", 0, "spotify:track:1"), ("own", 1, "spotify:track:2")]


def test_sync_mirror_skips_removal_on_suspicious_listing(monkeypatch):
    monkeypatch.setattr(pm, "_PAGE_SLEEP_S", 0)
    previous = {f"p{i}": None for i in range(100)}
    conn = FakeConn(_responder(previous))
    r = pm.sync_mirror(conn, FakeSp([_pl("p1", "x")], {}), sleep_s=0)
    assert r.removal_skipped
    assert not conn.sql_matching("SET removed_at")
