"""Release radar (v0.87, R7). Parsers and adapters run against SAVED fixtures
(tests/fixtures/release_radar/) through httpx.MockTransport / fake Spotify clients: nothing here
touches the network. The store + run tests use the throwaway Postgres 16 (conftest.pg_url)."""
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import psycopg
import pytest

import lib.release_radar as radar
from lib.release_radar import match, store
from lib.release_radar.artists import radar_artists
from lib.release_radar.http import USER_AGENT, PoliteHttp
from lib.release_radar.model import RadarArtist, ReleaseItem
from lib.release_radar.sources import musicbrainz, scantraxx, spotify

FIX = Path(__file__).parent / "fixtures" / "release_radar"
HH = RadarArtist(key="headhunterz", name="Headhunterz", spotify_id="0aJcPBUeTwNR5HJX0e6R0V", plays=500)
SR = RadarArtist(key="sound rush", name="Sound Rush", spotify_id="1SoundRush000000000000", plays=300)
DT = RadarArtist(key="da tweekaz", name="Da Tweekaz", spotify_id="2DaTweekaz000000000000", plays=200)
WS = RadarArtist(key="wildstylez", name="Wildstylez", spotify_id=None, plays=10, followed=True)


# ── matching ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("a,b", [
    ("Lost In Paradise (Extended Mix)", "Lost In Paradise"),
    ("Lost in Paradise - Original Mix", "LOST IN PARADISE"),
    ("Twilight (feat. Mandy) (Radio Edit)", "Twilight"),
    ("Jägermeister", "Jagermeister"),
    ("Hold On [Pro Mix]", "Hold On"),
])
def test_same_recording_titles_match(a, b):
    assert match.norm_title(a) == match.norm_title(b)


@pytest.mark.parametrize("a,b", [("Hold On (Rebelion Remix)", "Hold On"), ("Dance with Me", "Dance"), ("Part 2", "Part 1")])
def test_different_releases_stay_apart(a, b):
    assert match.norm_title(a) != match.norm_title(b)


def test_credit_matching():
    assert match.credit_matches("Da Tweekaz & Sound Rush", "sound rush")
    assert match.credit_matches("D-Block & S-te-Fan feat. Mandy", "d block and s te fan") is False  # '&' splits the duo
    assert match.credit_matches("D-Block & S-te-Fan", "d block")
    assert not match.credit_matches("Sound Rushers", "sound rush")
    assert match.dates_close(date(2026, 3, 6), date(2026, 3, 19)) and not match.dates_close(date(2026, 3, 6), date(2026, 3, 21))


# ── Scantraxx parser (saved HTML) ────────────────────────────────────────────

def test_scantraxx_article_fixture():
    rows = scantraxx.parse((FIX / "scantraxx_article.html").read_text(), 3, 2026)
    got = [(r["date"].isoformat(), r["artist"], r["title"]) for r in rows]
    assert got == [
        ("2026-03-06", "Da Tweekaz & Sound Rush", "Neverland"),
        ("2026-03-06", "Headhunterz", "Lost In Paradise (Extended Mix)"),
        ("2026-03-13", "Brennan Heart", "Imaginary Worlds"),
        ("2026-03-13", "Unknown Newcomer", "Some Title"),
        ("2026-03-13", "D-Block & S-te-Fan feat. Mandy", "Twilight (Radio Edit)"),
        ("2026-03-27", "Wildstylez", "Back In Time"),
        ("2026-03-13", "Coone", "Magic Mountain"),
    ]
    # nav, cookie banner, headline, links and footer are never releases
    assert not any("cookie" in r["title"].lower() or "rights" in r["title"].lower() or "http" in r["title"] for r in rows)


def test_scantraxx_table_fixture():
    rows = scantraxx.parse((FIX / "scantraxx_table.html").read_text(), 4, 2026)
    assert [(r["date"].isoformat(), r["artist"], r["title"]) for r in rows] == [
        ("2026-04-03", "Sound Rush", "Fearless"),
        ("2026-04-10", "Headhunterz", "The Return"),
        ("2026-04-17", "Da Tweekaz", "Jägermeister (Extended Mix)"),
    ]


LIVE_OCTOBER_2026 = [  # every card on the real page (trimmed capture, 2026-11-07)
    ("2026-10-02", "Devin Wild", "We Desire", "Scantraxx", "34665"),
    ("2026-10-02", "Demi Kanon,Caelum", "Paralyzed", "Scantraxx", "34666"),
    ("2026-10-02", "Gunz For Hire,Max Alexander", "Dream On", "Roughstate", "34667"),
    ("2026-10-02", "Frontliner", "Running Running Running (Drum & Bass Edit)", "This Is Hardstyle", "34671"),
    ("2026-10-09", "Nightcraft,Regain,Forsaken Two", "Drown In You", "Scantraxx", "34672"),
    ("2026-10-09", "DJ Isaac", "My House", "Scantraxx", "34673"),
    ("2026-10-16", "Devin Wild", "When The Book Is Closed", "Scantraxx", "34678"),
    ("2026-10-16", "Digital Punk", "Born For Greatness", "Scantraxx", "34679"),
    ("2026-10-23", "Demi Kanon", "Fall Behind", "Scantraxx", "34683"),
    ("2026-10-22", "Thyron", "clouds don't stay forever", "Scantraxx", "34682"),
    ("2026-10-30", "Devin Wild", "I Don't Know This Tempo", "Scantraxx", "34687"),
    ("2026-10-30", "RAVEWALKER", "Danse Macabre (Rave Till The End)", "Scantraxx", "34688"),
    ("2026-10-30", "The Prophet,Lil Texas,Revedge", "Wanna Play?", "Scantraxx", "34689"),
    ("2026-10-30", "E-Force,Unresolved", "Darkness", "SEVEN Records", "34692"),
]


def test_scantraxx_real_page_release_cards():
    """The real monthly page (trimmed capture): one card per release with artist(s), title, label
    (incl. sublabels and partner labels), a "DD / MM / YYYY" date and a stable /releases/<id> link."""
    rows = scantraxx.parse((FIX / "scantraxx_live_october_2026.html").read_text(), 10, 2026,
                           "https://www.scantraxx.com/news/releases-scantraxx-october-2026")
    got = [(r["date"].isoformat(), r["artist"], r["title"], r["label"], r["external_id"]) for r in rows]
    assert got == LIVE_OCTOBER_2026
    assert all(r["precision"] == "day" for r in rows)
    assert rows[0]["url"] == "https://www.scantraxx.com/releases/34665/we-desire"
    # Comma-separated credits match each artist on the radar.
    assert match.credit_matches(rows[1]["artist"], "caelum") and match.credit_matches(rows[4]["artist"], "regain")


def test_scantraxx_undated_lines_get_the_month():
    rows = scantraxx.parse("<article><p>Sound Rush – Untold</p></article>", 5, 2026)
    assert rows == [{"artist": "Sound Rush", "title": "Untold", "date": date(2026, 5, 1), "precision": "month", "url": None}]


def _transport(routes: dict, calls: list):
    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        for (path_part, q_part), resp in routes.items():
            if path_part in req.url.path and (q_part is None or q_part in str(req.url)):
                status, body = resp
                return httpx.Response(status, text=body) if isinstance(body, str) else httpx.Response(status, json=body)
        return httpx.Response(404, json={"error": "not found"})
    return httpx.MockTransport(handler)


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.slept: list[float] = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def test_scantraxx_fetch_this_month_and_next_politely(monkeypatch):
    monkeypatch.setenv("RADAR_SCANTRAXX_BASE", "https://label.test")
    calls: list = []
    clock = Clock()
    http = PoliteHttp(min_gap={"label.test": scantraxx.GAP_SECONDS}, sleep=clock.sleep, clock=clock.now,
                      transport=_transport({("releases-scantraxx-march-2026", None): (200, (FIX / "scantraxx_article.html").read_text())}, calls))
    res = scantraxx.fetch([HH, SR, DT, WS], http=http, today=date(2026, 3, 2))
    assert [str(c.url) for c in calls] == ["https://label.test/news/releases-scantraxx-march-2026", "https://label.test/news/releases-scantraxx-april-2026"]
    assert res.ok and res.requests == 2  # next month's 404 is normal
    assert clock.slept == [scantraxx.GAP_SECONDS]
    assert all(c.headers["user-agent"] == USER_AGENT for c in calls)
    titles = {(i.artist_key, i.title) for i in res.items}
    # Only artists on the radar: Unknown Newcomer, Brennan Heart, Coone and D-Block aren't.
    assert titles == {("sound rush", "Neverland"), ("headhunterz", "Lost In Paradise (Extended Mix)"), ("wildstylez", "Back In Time")}
    assert all(i.label == "Scantraxx" and i.url.endswith("march-2026") for i in res.items)


def test_scantraxx_missing_this_month_is_a_failure(monkeypatch):
    monkeypatch.setenv("RADAR_SCANTRAXX_BASE", "https://label.test")
    http = PoliteHttp(sleep=lambda s: None, transport=_transport({}, []))
    res = scantraxx.fetch([HH], http=http, today=date(2026, 3, 2))
    assert not res.ok and "404" in res.fatal


# ── MusicBrainz (saved JSON) ─────────────────────────────────────────────────

@pytest.fixture
def conn(pg_url):
    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("""TRUNCATE spotify_plays, track_metadata, liked_songs, radar_releases, radar_release_sources, radar_mb_artists,
                     radar_followed_artists, radar_runs, push_log RESTART IDENTITY CASCADE""")
        c.execute("""UPDATE radar_sources SET enabled = true, last_run_at = NULL, last_success_at = NULL, last_error = NULL,
                     consecutive_failures = 0, failing_since = NULL, failure_notified_at = NULL""")
        yield c


def mb_routes(release_json=None):
    return {
        ("/ws/2/url", "0aJcPBUeTwNR5HJX0e6R0V"): (200, json.loads((FIX / "mb_url_spotify.json").read_text())),
        ("/ws/2/artist", "Sound"): (200, json.loads((FIX / "mb_artist_search.json").read_text())),
        ("/ws/2/release", None): release_json or (200, json.loads((FIX / "mb_release_search.json").read_text())),
    }


def test_musicbrainz_maps_by_spotify_url_then_unique_name_and_respects_the_rate(conn, monkeypatch):
    monkeypatch.setenv("RADAR_MUSICBRAINZ_BASE", "https://mb.test/ws/2")
    calls: list = []
    clock = Clock()
    http = PoliteHttp(min_gap={"mb.test": 1.1}, sleep=clock.sleep, clock=clock.now, transport=_transport(mb_routes(), calls))
    res = musicbrainz.fetch(conn, [HH, SR, DT], http=http, today=date(2026, 3, 1))
    refs = dict(conn.execute("SELECT artist_ref, matched_by FROM radar_mb_artists").fetchall())
    assert refs == {HH.spotify_id: "spotify_url", SR.spotify_id: "name", DT.spotify_id: None}  # Da Tweekaz: no unique match
    # Every request ≥ 1.1 s after the previous one (under 1 request/second), with our User-Agent and no e-mail.
    assert len(clock.slept) == len(calls) - 1 and all(s >= 1.09 for s in clock.slept)
    for c in calls:
        assert c.headers["user-agent"] == "RotorMusicHub/0.87 ( https://github.com/steynvg00/music-tracker )"
        assert "@" not in " ".join(c.headers.values())
    # Two editions of one release group → one item with the earliest date; the 2019 one is outside the window.
    lip = [i for i in res.items if i.artist_key == "headhunterz" and i.title == "Lost In Paradise"]
    assert len(lip) == 1 and lip[0].release_date == date(2026, 3, 6) and lip[0].label == "Scantraxx"
    assert lip[0].url == "https://musicbrainz.org/release-group/rg-lost-in-paradise"
    assert not any(i.title == "Old Classic" for i in res.items)
    # Second run: mapping comes from the cache (no /url or /artist look-ups).
    calls.clear()
    musicbrainz.fetch(conn, [HH, SR, DT], http=http, today=date(2026, 3, 1))
    assert not any("/ws/2/url" in str(c.url) or "/ws/2/artist" in str(c.url) for c in calls)


# ── Spotify (saved JSON, fake client) ────────────────────────────────────────

class FakeSp:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls: list[str] = []

    def artist_albums(self, artist_id, album_type=None, country=None, limit=None):
        self.calls.append(f"albums:{artist_id}:{album_type}")
        if self.fail:
            raise RuntimeError("HTTP 503")
        return json.loads((FIX / "spotify_artist_albums.json").read_text()) if artist_id == HH.spotify_id else {"items": []}

    def album_tracks(self, album_id, limit=50, offset=0):
        self.calls.append(f"tracks:{album_id}")
        return {"items": [{"uri": f"spotify:track:{album_id[:21]}{n}"} for n in range(2)], "next": None}


def test_spotify_adapter_recent_releases_and_playlist_tracks():
    sp = FakeSp()
    res = spotify.fetch([HH, SR, WS], sp=sp, today=date(2026, 3, 10))
    assert [i.title for i in res.items] == ["Lost In Paradise"]           # older than 60 days / year-only dates skipped
    assert res.items[0].track_uris and res.items[0].spotify_album_id == "1AbCdEfGhIjKlMnOpQrSt1"
    assert "albums:0aJcPBUeTwNR5HJX0e6R0V:album,single" in sp.calls
    assert not any(c.startswith(f"albums:{None}") for c in sp.calls)    # followed artist without Spotify id: skipped
    res2 = spotify.fetch([HH], sp=sp, today=date(2026, 3, 30))            # 24 days old: out, no playlist tracks
    assert res2.items[0].track_uris == []
    assert not spotify.fetch([HH, SR], sp=FakeSp(fail=True), today=date(2026, 3, 10)).ok


# ── store + daily run (throwaway Postgres) ───────────────────────────────────

def _seed_listening(c):
    now = datetime.now(timezone.utc)
    for uri, aid, name, n in (("spotify:track:HH000000000000000000001", HH.spotify_id, "Headhunterz", 30),
                              ("spotify:track:SR000000000000000000001", SR.spotify_id, "Sound Rush", 20),
                              ("spotify:track:OLD00000000000000000001", "3OldArtist000000000000", "Old Artist", 50)):
        c.execute("INSERT INTO track_metadata (track_uri, artist_ids, artist_names, album_id) VALUES (%s, %s, %s, 'albumx')", (uri, [aid], [name]))
        for k in range(n):
            when = now - timedelta(days=k) if name != "Old Artist" else now - timedelta(days=900 + k)
            c.execute("INSERT INTO spotify_plays (played_at, ms_played, track_uri, track_name, artist_name) VALUES (%s, 1000, %s, %s, %s)",
                      (when, uri, f"{name} song", name))


def test_radar_artists_top_by_recent_plays_plus_followed(conn):
    _seed_listening(conn)
    conn.execute("INSERT INTO radar_followed_artists (artist_id, name) VALUES ('4Wildstylez00000000000', 'Wildstylez')")
    got = radar_artists(conn)
    assert [(a.name, a.plays, a.followed) for a in got] == [("Headhunterz", 30, False), ("Sound Rush", 20, False), ("Wildstylez", 0, True)]
    assert len(radar_artists(conn, top=1)) == 2  # the top-N cut never drops a followed artist


def item(source, ext, artist, title, d, prec="day", **kw):
    return ReleaseItem(source=source, external_id=ext, artist_key=match.norm_artist(artist), artist_name=artist, title=title,
                       release_date=d, precision=prec, **kw)


def test_upsert_merges_one_release_from_three_sources(conn):
    r1 = store.upsert(conn, [item("scantraxx", "s1", "Headhunterz", "Lost In Paradise (Extended Mix)", date(2026, 3, 6), label="Scantraxx")])
    r2 = store.upsert(conn, [item("musicbrainz", "rg1", "Headhunterz", "Lost in Paradise", date(2026, 3, 7))])
    r3 = store.upsert(conn, [item("spotify", "1AbCdEfGhIjKlMnOpQrSt1", "Headhunterz", "Lost In Paradise", date(2026, 3, 6),
                                  spotify_album_id="1AbCdEfGhIjKlMnOpQrSt1", url="https://open.spotify.com/album/1AbCdEfGhIjKlMnOpQrSt1",
                                  track_uris=["spotify:track:aaaaaaaaaaaaaaaaaaaaa0"])])
    assert (r1["created"], r2["merged"], r3["merged"]) == (1, 1, 1)
    rows = conn.execute("SELECT title, label, spotify_album_id, release_date FROM radar_releases").fetchall()
    assert rows == [("Lost In Paradise", "Scantraxx", "1AbCdEfGhIjKlMnOpQrSt1", date(2026, 3, 6))]
    assert conn.execute("SELECT count(*) FROM radar_release_sources").fetchone()[0] == 3
    # A month-only label line merges with a dated one; a date 3 weeks off is a different release.
    store.upsert(conn, [item("scantraxx", "s2", "Sound Rush", "Untold", date(2026, 5, 1), prec="month"),
                        item("musicbrainz", "rg2", "Sound Rush", "Untold", date(2026, 5, 15)),
                        item("musicbrainz", "rg3", "Headhunterz", "Lost In Paradise", date(2026, 4, 1))])
    assert conn.execute("SELECT date_precision, release_date FROM radar_releases WHERE title_key = 'untold'").fetchall() == [("day", date(2026, 5, 15))]
    assert conn.execute("SELECT count(*) FROM radar_releases WHERE title_key = 'lost in paradise'").fetchone()[0] == 2
    # The same source item seen again updates, never duplicates.
    store.upsert(conn, [item("scantraxx", "s1", "Headhunterz", "Lost In Paradise (Extended Mix)", date(2026, 3, 6), label="Scantraxx")])
    assert conn.execute("SELECT count(*) FROM radar_release_sources").fetchone()[0] == 6


def test_in_library_from_plays_likes_or_title(conn):
    _seed_listening(conn)
    conn.execute("SELECT hub.refresh_rollups(true)")
    store.upsert(conn, [
        item("spotify", "A1", "Headhunterz", "Played", date(2026, 3, 1), spotify_album_id="A1", track_uris=["spotify:track:HH000000000000000000001"]),
        item("spotify", "A2", "Sound Rush", "Liked", date(2026, 3, 1), spotify_album_id="A2", track_uris=["spotify:track:LIKED0000000000000000001"]),
        item("scantraxx", "x", "Sound Rush", "Sound Rush song (Extended Mix)", date(2026, 3, 1)),
        item("scantraxx", "y", "Sound Rush", "Brand New", date(2026, 3, 1)),
    ])
    conn.execute("INSERT INTO liked_songs (track_uri, liked_at, track_name, artist_name, album_name) VALUES ('spotify:track:LIKED0000000000000000001', now(), 'Liked', 'Sound Rush', 'X')")
    assert store.refresh_in_library(conn) == 3
    assert conn.execute("SELECT title FROM radar_releases WHERE NOT in_library").fetchall() == [("Brand New",)]


def _http_for_run(monkeypatch, mb_status=200):
    monkeypatch.setenv("RADAR_SCANTRAXX", "on")  # off by default until verified on a real page
    monkeypatch.setenv("RADAR_MUSICBRAINZ_BASE", "https://mb.test/ws/2")
    monkeypatch.setenv("RADAR_SCANTRAXX_BASE", "https://label.test")
    routes = mb_routes((mb_status, json.loads((FIX / "mb_release_search.json").read_text()) if mb_status == 200 else {"error": "down"}))
    if mb_status != 200:
        routes = {k: (mb_status, {"error": "down"}) for k in routes}
    routes[("releases-scantraxx-march-2026", None)] = (200, (FIX / "scantraxx_article.html").read_text())
    return PoliteHttp(sleep=lambda s: None, transport=_transport(routes, []))


def test_daily_run_end_to_end_and_three_day_failure_alert(conn, monkeypatch):
    _seed_listening(conn)
    conn.execute("SELECT hub.refresh_rollups(true)")
    pushes = []
    push = lambda c, **kw: pushes.append(kw) or 1  # noqa: E731
    day = date(2026, 3, 8)
    s = radar.run(conn, sp_factory=lambda: FakeSp(), push=push, today=day, http=_http_for_run(monkeypatch))
    assert s["artists"] == 2 and all(v["status"] == "ok" for v in s["sources"].values()), s
    # "Lost In Paradise": Spotify + MusicBrainz + Scantraxx → one release with three sources.
    rid = conn.execute("SELECT id FROM radar_releases WHERE title_key = 'lost in paradise'").fetchall()
    assert len(rid) == 1
    assert sorted(r[0] for r in conn.execute("SELECT source FROM radar_release_sources WHERE release_id = %s", (rid[0][0],))) == ["musicbrainz", "scantraxx", "spotify"]
    assert conn.execute("SELECT count(*) FROM radar_sources WHERE last_success_at IS NOT NULL").fetchone()[0] == 3
    assert conn.execute("SELECT count(*) FROM radar_runs").fetchone()[0] == 1

    # MusicBrainz down three days in a row → exactly one push; a fourth day sends nothing more.
    for k in range(4):
        s = radar.run(conn, sp_factory=lambda: FakeSp(), push=push, today=day + timedelta(days=1 + k), http=_http_for_run(monkeypatch, 503))
        assert s["sources"]["musicbrainz"]["status"] == "failed" and s["sources"]["spotify"]["status"] == "ok"
    alerts = [p for p in pushes if p["kind"] == "radar"]
    assert len(alerts) == 1 and "MusicBrainz has failed 3 days in a row" in alerts[0]["body"] and alerts[0]["url"] == "/radar"
    st = conn.execute("SELECT consecutive_failures, failing_since, failure_notified_at IS NOT NULL FROM radar_sources WHERE source = 'musicbrainz'").fetchone()
    assert st == (4, day + timedelta(days=1), True)
    # Recovery resets the streak.
    radar.run(conn, sp_factory=lambda: FakeSp(), push=push, today=day + timedelta(days=6), http=_http_for_run(monkeypatch))
    assert conn.execute("SELECT consecutive_failures, failing_since FROM radar_sources WHERE source = 'musicbrainz'").fetchone() == (0, None)


def test_scantraxx_is_on_by_default_uses_the_www_host_and_can_be_switched_off(conn, monkeypatch):
    monkeypatch.delenv("RADAR_SCANTRAXX", raising=False)
    monkeypatch.delenv("RADAR_SCANTRAXX_BASE", raising=False)
    assert scantraxx.page_url(10, 2026) == "https://www.scantraxx.com/news/releases-scantraxx-october-2026"
    assert scantraxx.enabled()  # verified against the real page (2026-11-07)
    monkeypatch.setenv("RADAR_SCANTRAXX", "off")
    assert not scantraxx.enabled()
    _seed_listening(conn)
    calls: list = []
    http = PoliteHttp(sleep=lambda s: None, transport=_transport({}, calls))
    conn.execute("UPDATE radar_sources SET enabled = false WHERE source = 'musicbrainz'")
    s = radar.run(conn, sp_factory=lambda: FakeSp(), push=lambda c, **k: 0, today=date(2026, 3, 8), http=http)
    assert s["sources"]["scantraxx"] == {"status": "disabled", "reason": "turned off with RADAR_SCANTRAXX=off"}
    assert calls == []  # not a single label request


def test_scantraxx_fetch_on_the_real_page_matches_radar_artists(monkeypatch):
    monkeypatch.setenv("RADAR_SCANTRAXX_BASE", "https://label.test")
    page = (FIX / "scantraxx_live_october_2026.html").read_text()
    http = PoliteHttp(sleep=lambda s: None, transport=_transport({("releases-scantraxx-october-2026", None): (200, page)}, []))
    radar_artists_ = [RadarArtist(key="devin wild", name="Devin Wild", spotify_id=None, plays=9),
                      RadarArtist(key="caelum", name="Caelum", spotify_id=None, plays=3),
                      RadarArtist(key="unresolved", name="Unresolved", spotify_id=None, plays=2)]
    res = scantraxx.fetch(radar_artists_, http=http, today=date(2026, 10, 5))
    got = sorted((i.artist_key, i.title, i.label, i.external_id, i.release_date.isoformat()) for i in res.items)
    assert got == [
        ("caelum", "Paralyzed", "Scantraxx", "release:34666", "2026-10-02"),
        ("devin wild", "I Don't Know This Tempo", "Scantraxx", "release:34687", "2026-10-30"),
        ("devin wild", "We Desire", "Scantraxx", "release:34665", "2026-10-02"),
        ("devin wild", "When The Book Is Closed", "Scantraxx", "release:34678", "2026-10-16"),
        ("unresolved", "Darkness", "SEVEN Records", "release:34692", "2026-10-30"),
    ]
    assert all(i.url.startswith("https://label.test/releases/") for i in res.items)


def test_disabled_source_is_skipped_and_no_artists_means_no_requests(conn, monkeypatch):
    calls: list = []
    http = PoliteHttp(sleep=lambda s: None, transport=_transport({}, calls))
    s = radar.run(conn, sp_factory=lambda: pytest.fail("no Spotify call without artists"), push=lambda c, **k: 0, today=date(2026, 3, 8), http=http)
    assert s == {"artists": 0, "sources": {}, "skipped": "no artists"} and calls == []
    _seed_listening(conn)
    conn.execute("UPDATE radar_sources SET enabled = false, disabled_reason = 'test' WHERE source IN ('musicbrainz', 'scantraxx')")
    s = radar.run(conn, sp_factory=lambda: FakeSp(), push=lambda c, **k: 0, today=date(2026, 3, 8), http=http)
    assert s["sources"]["musicbrainz"] == {"status": "disabled"} and s["sources"]["scantraxx"] == {"status": "disabled"}
    assert calls == []
