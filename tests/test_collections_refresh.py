"""lib/collections_refresh.py (v0.84, R4): YouTube III.E.4 — refresh within 30 days or delete."""
from lib import collections_refresh as cr


def test_iso_duration():
    assert cr.iso_duration_ms("PT3M33S") == 213_000
    assert cr.iso_duration_ms("PT1H") == 3_600_000
    assert cr.iso_duration_ms("PT") is None
    assert cr.iso_duration_ms(None) is None


def test_youtube_client_counts_units_and_batches_50():
    seen = []

    def http(url):
        seen.append(url)
        ids = url.split("id=")[1].split("&")[0].split("%2C")
        return {"items": [{"id": i} for i in ids]}

    yt = cr.YouTube("k", http)
    got = yt.videos([f"v{n:010d}" for n in range(120)])
    assert len(got) == 120
    assert yt.units == 3
    assert all("key=k" in u and u.startswith(cr.YT_BASE + "/videos?") for u in seen)


class _Cur:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []

    def execute(self, sql, params=None):
        self.conn.sql.append(" ".join(sql.split()))
        self._rows = self.conn.respond(" ".join(sql.split()))

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    def __init__(self, respond):
        self.respond, self.sql = respond, []

    def cursor(self):
        return _Cur(self)

    def commit(self):
        pass

    def rollback(self):
        pass


def test_without_a_key_nothing_is_fetched_and_stale_youtube_data_is_deleted():
    def respond(sql):
        if sql.startswith("DELETE FROM media_items WHERE source = 'youtube' AND last_checked_at"):
            return [("m1",), ("m2",)]
        return []

    calls = []
    conn = FakeConn(respond)
    s = cr.refresh(conn, key="", http=lambda u: calls.append(u), sc_http=lambda u: calls.append(u))
    assert calls == []
    assert s["deleted_stale"] == 2
    assert any(q.startswith("DELETE FROM media_items WHERE source = 'youtube' AND last_checked_at < now() -") for q in conn.sql)


def test_a_video_that_no_longer_comes_back_is_marked_unavailable():
    def respond(sql):
        if sql.startswith("SELECT id, source_id FROM media_items"):
            return [("m1", "aaaaaaaaaaa"), ("m2", "bbbbbbbbbbb")]
        if sql.startswith("INSERT INTO media_items"):
            return [("m1",)]
        return []

    def http(url):
        return {"items": [{"id": "aaaaaaaaaaa", "snippet": {"title": "A"}, "status": {"embeddable": True}}]}

    conn = FakeConn(respond)
    s = cr.refresh(conn, key="k", http=http, sc_http=lambda u: {})
    assert s["youtube_items"] == 1 and s["unavailable"] == 1
    assert any(q.startswith("UPDATE media_items SET unavailable = true") for q in conn.sql)
