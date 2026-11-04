from datetime import date, datetime, timedelta, timezone

import pytest

from lib import daily_picks as dp
from lib.daily_picks import Context, PoolPlaylist, TrackStat
from tests.conftest import FakeConn

NOW = datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc)
TODAY = date(2026, 11, 4)


def T(i, **kw):
    base = dict(uri=f"spotify:track:{i:022d}", name=f"Track {i}", artist=f"Artist {i % 5}",
                plays=1, duration_ms=240_000)
    base.update(kw)
    return TrackStat(**base)


def ago(days):
    return NOW - timedelta(days=days)


def ctx(tracks, **kw):
    return Context(today=TODAY, now=NOW, rng=dp.seeded_rng(TODAY), tracks=tracks, **kw)


# ── helpers ──

def test_today_local_uses_amsterdam():
    assert dp.today_local(datetime(2026, 11, 4, 23, 30, tzinfo=timezone.utc)) == date(2026, 11, 5)
    assert dp.today_local(datetime(2026, 7, 1, 21, 59, tzinfo=timezone.utc)) == date(2026, 7, 1)
    assert dp.today_local(datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)) == date(2026, 7, 2)


def test_fill_to_duration_target_min_max_and_dedupe():
    tracks = [T(i) for i in range(40)]
    picked = dp.fill_to_duration(tracks)  # 75 min of 4-min tracks → 19
    assert len(picked) == 19
    assert dp.fill_to_duration(tracks[:5]) is None
    assert len(dp.fill_to_duration(tracks, target_ms=10**12, max_tracks=12)) == 12
    dupes = [T(1), T(2, name="Track 1", artist="Artist 1")] + [T(i) for i in range(3, 12)]
    assert [t.uri for t in dp.fill_to_duration(dupes, min_tracks=1)].count(T(2).uri) == 0


def test_weighted_order_is_deterministic_and_favours_weight():
    items = list(range(50))
    a = dp.weighted_order(dp.seeded_rng(TODAY), items, lambda x: 1 + x)
    b = dp.weighted_order(dp.seeded_rng(TODAY), items, lambda x: 1 + x)
    assert a == b and sorted(a) == items
    assert sum(a[:10]) > sum(a[-10:])


def test_recipe_cycle_rotates_daily_and_reseed_shifts_by_three():
    c0 = dp.recipe_cycle(TODAY)
    c1 = dp.recipe_cycle(TODAY + timedelta(days=1))
    assert sorted(c0) == sorted(dp.RECIPE_ORDER)
    assert c1[0] == c0[1]
    assert dp.recipe_cycle(TODAY, reseed=1)[0] == c0[3]


def test_format_duration():
    assert dp.format_duration(75 * 60_000) == "1 h 15 min"
    assert dp.format_duration(52 * 60_000) == "52 min"


# ── recipes ──

def test_forgotten_gems_selects_only_liked_old_heavy_rotation():
    good = [T(i, liked=True, plays=30, last_played=ago(200)) for i in range(30)]
    noise = [T(100, liked=False, plays=99, last_played=ago(400)),
             T(101, liked=True, plays=5, last_played=ago(400)),
             T(102, liked=True, plays=50, last_played=ago(10))]
    c = dp.recipe_forgotten_gems(ctx(good + noise))
    assert c.kind == "generated" and c.recipe == "forgotten_gems"
    assert not {t.uri for t in noise} & set(c.track_uris)
    assert 8 <= len(c.track_uris) <= 100
    assert c.reason.startswith(f"{len(c.track_uris)} liked tracks")
    assert dp.recipe_forgotten_gems(ctx(noise)) is None


def test_evergreen_core_needs_rest():
    tracks = [T(i, evergreen_pct=0.9, last_played=ago(30)) for i in range(20)]
    tracks += [T(50 + i, evergreen_pct=0.95, last_played=ago(3)) for i in range(20)]
    c = dp.recipe_evergreen_core(ctx(tracks))
    assert all(int(u[-3:]) < 50 for u in c.track_uris)


def test_fresh_heat_mixes_hot_and_unplayed_new():
    hot = [T(i, plays_14d=10 - i % 10, plays=20) for i in range(15)]
    new = [T(500 + i, plays=0) for i in range(15)]
    c = dp.recipe_fresh_heat(ctx(hot, missed_new=new))
    uris = set(c.track_uris)
    assert uris & {t.uri for t in hot} and uris & {t.uri for t in new}
    assert "new releases" in c.reason
    only_hot = dp.recipe_fresh_heat(ctx(hot))
    assert "new releases" not in only_hot.reason


def test_artist_deep_dive_respects_cooldown_and_low_plays():
    tracks = [T(i, artist="Hard Driver", plays=i % 3) for i in range(30)]
    tracks += [T(100 + i, artist="Da Tweekaz", plays=1) for i in range(30)]
    tracks += [T(200 + i, artist="Da Tweekaz", plays=10) for i in range(30)]
    recent = [{"pick_date": TODAY - timedelta(days=3), "recipe": "artist_deep_dive",
               "params": {"artist": "Hard Driver"}, "playlist_id": None}]
    c = dp.recipe_artist_deep_dive(ctx(tracks, top_artists=["Hard Driver", "Da Tweekaz"], recent=recent))
    assert c.params == {"artist": "Da Tweekaz"} and c.title == "Deep dive: Da Tweekaz"
    assert all(100 <= int(u[-3:]) < 200 for u in c.track_uris)


def test_artist_deep_dive_matches_featured_artists():
    tracks = [T(i, artist="Someone", artists=("Someone", "Featured"), plays=0, liked=True) for i in range(20)]
    c = dp.recipe_artist_deep_dive(ctx(tracks, top_artists=["Featured"]))
    assert c and len(c.track_uris) >= 8


def test_discovered_in_year_skips_current_and_recent_years():
    tracks = []
    for y in (2021, 2022, 2026):
        tracks += [T(y * 100 + i, plays=10, first_played=datetime(y, 6, 1, tzinfo=timezone.utc))
                   for i in range(20)]
    recent = [{"pick_date": TODAY - timedelta(days=2), "recipe": "discovered_in_year",
               "params": {"year": 2021}, "playlist_id": None}]
    c = dp.recipe_discovered_in_year(ctx(tracks, recent=recent))
    assert c.params == {"year": 2022} and c.title == "Discovered in 2022"


# ── existing playlists ──

def P(pid, **kw):
    base = dict(playlist_id=pid, name=pid, owner_id="me", is_owned=True, is_collab=False,
                managed_kind=None, track_count=40)
    base.update(kw)
    return PoolPlaylist(**base)


def test_pool_rules():
    c = ctx([])
    assert dp.eligible(P("own"), c)
    assert dp.eligible(P("snap", managed_kind="auto_snapshot"), c)
    assert not dp.eligible(P("auto", managed_kind="auto_updating"), c)
    assert not dp.eligible(P("custom", managed_kind="custom"), c)
    assert not dp.eligible(P("ra", name="Recently Added Tracks"), c)
    assert not dp.eligible(P("dw", owner_id="spotify", is_owned=False), c)
    assert not dp.eligible(P("tiny", track_count=3), c)
    assert not dp.eligible(P("recent", last_suggested_on=TODAY - timedelta(days=10)), c)
    assert dp.eligible(P("old", last_suggested_on=TODAY - timedelta(days=31)), c)
    c2 = ctx([], recent=[{"pick_date": TODAY - timedelta(days=2), "playlist_id": "x", "recipe": None}])
    assert not dp.eligible(P("x"), c2)


def test_rotation_score_formula():
    heard = T(1, plays_60d=3, composite=0.8)
    unheard = T(2, plays_60d=0, composite=0.4)
    c = ctx([heard, unheard])
    never = P("a", item_uris=(heard.uri, unheard.uri))
    score, cov = dp.rotation_score(never, c)
    # 0.5·1 + 0.3·(1 − 0.5) + 0.2·0.6
    assert cov == 0.5 and score == pytest.approx(0.5 + 0.15 + 0.12)
    followed = P("b", is_owned=False, last_suggested_on=TODAY - timedelta(days=73))
    score_f, cov_f = dp.rotation_score(followed, c)
    assert cov_f is None and score_f == pytest.approx(0.5 * 0.2 + 0.3 * 0.5 + 0.2 * 0.5)


def test_existing_reason_lines():
    c = ctx([])
    assert dp.existing_reason(P("a"), c, 0.12) == "Not suggested by Rotor yet · 12% of it heard in the last 60 days"
    assert dp.existing_reason(P("b", is_owned=False, last_suggested_on=TODAY - timedelta(days=41)), c, None) \
        == "Last suggested 41 days ago · followed playlist, play only"


def test_build_deck_interleaves_and_falls_back():
    tracks = ([T(i, liked=True, plays=30, last_played=ago(200), evergreen_pct=0.9) for i in range(40)]
              + [T(100 + i, plays_14d=5, plays=10) for i in range(20)])
    pool = [P("p1"), P("p2"), P("p3")]
    deck = dp.build_deck(ctx(tracks), pool)
    assert [c.kind for c in deck] == ["generated", "existing_playlist", "generated", "existing_playlist", "generated"]
    no_pool = dp.build_deck(ctx(tracks), [])
    assert len(no_pool) == 3 and all(c.kind == "generated" for c in no_pool)


def test_reseed_never_repeats_plain_recipes():
    tracks = [T(i, liked=True, plays=30, last_played=ago(200), evergreen_pct=0.9, plays_14d=3) for i in range(40)]
    today = [{"pick_date": TODAY, "rank": r, "recipe": name, "params": {}, "playlist_id": None}
             for r, name in enumerate(["forgotten_gems", "evergreen_core", "fresh_heat"], start=1)]
    deck = dp.build_deck(ctx(tracks, deck_so_far=list(today)), [], reseed=1)
    assert not {c.recipe for c in deck} & {"forgotten_gems", "evergreen_core", "fresh_heat"}


def test_same_day_same_deck():
    tracks = [T(i, liked=True, plays=30, last_played=ago(200)) for i in range(60)]
    a = dp.build_deck(ctx(tracks), [P("p1"), P("p2")])
    b = dp.build_deck(ctx(tracks), [P("p1"), P("p2")])
    assert [c.track_uris for c in a] == [c.track_uris for c in b]


# ── generate() orchestration against a fake DB ──

def _gen_conn(today_rows=(), state=None):
    def respond(sql, params):
        if "FROM daily_pick_candidates" in sql:
            return [(r["pick_date"], r["rank"], r["recipe"], r["params"], r["playlist_id"]) for r in today_rows]
        if "FROM daily_pick_state" in sql:
            return [state] if state else []
        if "WITH s AS" in sql:
            return [(f"spotify:track:{i:022d}", f"T{i}", "A", None, 30, 0, 0, ago(900), ago(200),
                     True, 200_000, None, None) for i in range(40)]
        return []
    return FakeConn(respond)


def test_generate_skips_existing_day():
    conn = _gen_conn(today_rows=[{"pick_date": TODAY, "rank": 1, "recipe": "x", "params": {}, "playlist_id": None}])
    assert dp.generate(conn, TODAY, now=NOW).status == "exists"
    assert not conn.sql_matching("INSERT")


def test_generate_writes_ranks_and_state():
    conn = _gen_conn()
    r = dp.generate(conn, TODAY, now=NOW)
    assert r.status == "generated" and r.start_rank == 1
    ranks = [p[1] for _, p in conn.sql_matching("INSERT INTO daily_pick_candidates")]
    assert ranks == list(range(1, len(r.deck) + 1))
    assert conn.sql_matching("INSERT INTO daily_pick_state")


def test_generate_reseed_appends_after_last_rank():
    rows = [{"pick_date": TODAY, "rank": r, "recipe": "forgotten_gems" if r == 1 else None,
             "params": {}, "playlist_id": None} for r in range(1, 6)]
    conn = _gen_conn(today_rows=rows)
    r = dp.generate(conn, TODAY, reseed=True, now=NOW)
    assert r.status == "reseeded" and r.start_rank == 6
    state_sql = conn.sql_matching("INSERT INTO daily_pick_state")[0][0]
    assert "reseed_requested_at = NULL" in state_sql


def test_force_refuses_a_played_day():
    rows = [{"pick_date": TODAY, "rank": 1, "recipe": "x", "params": {}, "playlist_id": None}]
    conn = _gen_conn(today_rows=rows, state=(2, 1, [1]))
    with pytest.raises(RuntimeError):
        dp.generate(conn, TODAY, force=True, now=NOW)


def test_dry_run_writes_nothing():
    conn = _gen_conn()
    assert dp.generate(conn, TODAY, dry_run=True, now=NOW).deck
    assert not conn.sql_matching("INSERT")
