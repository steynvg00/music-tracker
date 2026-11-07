"""Seed a THROWAWAY Postgres for the Rotor E2E run, plus the matching Spotify mock state.

  uv run python hub/e2e/seed.py --db postgresql://localhost:55432/rotor_e2e --state out/spotify-state.json [--plays 30000]

Deterministic (random seed 42). Refuses any DATABASE_URL that isn't localhost.
Creates: ~7 years of plays (Zipf-ish popularity, ISRC variants), track_metadata, liked songs,
popularity scores, badges, one playlist of every kind (managed 🔄/📸/🎧, own unmanaged,
followed, suffix-spoofed, not-owned-with-suffix), playlist settings, the rules catalog
(real lib/rules_catalog) and today's daily-pick deck (real lib/daily_picks generator).
"""
import argparse
import html
import json
import random
import string
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402

AMS = ZoneInfo("Europe/Amsterdam")
OWNER = "e2eowner"
OTHER = "someoneelse"
rng = random.Random(42)
B62 = string.ascii_letters + string.digits


def sid() -> str:
    return "".join(rng.choice(B62) for _ in range(22))


ARTIST_NAMES = [
    "Da Tweekaz", "Radical Redemption", "Headhunterz", "Sub Zero Project", "D-Block & S-te-Fan", "Wildstylez",
    "Brennan Heart", "Coone", "Atmozfears", "Noisecontrollers", "Phuture Noize", "Rebelion", "Sound Rush",
    "Frontliner", "Zatox", "Ran-D", "Adaro", "B-Front", "Warface", "Act of Rage", "Unresolved", "Vertile",
    "Aftershock", "Mandy", "Daybreak", "Bass Modulators", "Max Enforcer", "Psyko Punkz", "Josh & Wesz",
    "Galactixx", "Audiotricz", "Clockartz", "Ecstatic", "Mark With a K", "Hard Driver", "Devin Wild",
    "Toneshifterz", "Regain", "Primeshock", "KELTEK",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--plays", type=int, default=30000)
    args = ap.parse_args()
    if not any(h in args.db for h in ("@localhost", "@127.0.0.1", "://localhost", "://127.0.0.1", "host=/")):
        sys.exit("refusing: --db is not a local database")

    today = datetime.now(AMS).date()
    artists = [{"id": sid(), "name": n} for n in ARTIST_NAMES]
    tracks = []  # canonical (album) tracks
    for i in range(400):
        a = artists[min(int(rng.paretovariate(1.2)) - 1, len(artists) - 1) if rng.random() < 0.6 else rng.randrange(len(artists))]
        credit = [a] + ([rng.choice(artists)] if rng.random() < 0.15 else [])
        credit = list({x["id"]: x for x in credit}.values())
        year = rng.randint(2008, today.year)
        album = {"id": sid(), "name": f"{credit[0]['name']} – Album {rng.randint(1, 6)}"}
        tracks.append({
            "uri": f"spotify:track:{sid()}", "name": f"Track {i + 1:03d} {rng.choice(['Rise', 'Fall', 'Fire', 'Echo', 'Storm', 'Gold', 'Pulse'])}",
            "artists": credit, "album": album, "year": year, "duration_ms": rng.randint(150_000, 300_000),
            "isrc": f"NL{''.join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(10))}",
        })
    # Single releases of 30 tracks: separate URIs, same ISRC → canonical = the album URI.
    variants = []
    for t in tracks[:30]:
        variants.append({**t, "uri": f"spotify:track:{sid()}", "album": {"id": sid(), "name": f"{t['name']} (Single)"}, "single_of": t["uri"]})
    every = tracks + variants
    weights = [1 / (k + 1) ** 0.9 for k in range(len(tracks))]

    # ── plays ──
    start = date(2019, 1, 1)
    days = (today - start).days + 1
    rows = []
    platforms = ["iOS 17.1 (iPhone15,2)", "OS X 14.1.0 [x86 8]", "Android OS 13 API 33", "windows 10 (10.0.19045)", "web_player osx 14", None]
    reasons = ["trackdone"] * 70 + ["fwdbtn"] * 15 + ["endplay"] * 5 + ["backbtn"] * 3 + ["clickrow"] * 4 + ["remote"] * 3
    seen = set()

    def add_play(day: date, minute: int, t: dict):
        local = datetime(day.year, day.month, day.day, tzinfo=AMS) + timedelta(minutes=minute)
        at = local.astimezone(timezone.utc)
        key = (at, t["uri"])
        if key in seen:
            return
        seen.add(key)
        # Like production: export plays carry ms_played; plays from the recently-played API (the last
        # 30 days here) have none, so hours must fall back to the track length (migration 0026).
        ms = None if day >= today - timedelta(days=30) else rng.randint(30_000, t["duration_ms"])
        rows.append((at, ms, rng.choice(platforms), "NL", t["uri"], t["name"],
                     ", ".join(a["name"] for a in t["artists"]), t["album"]["name"], rng.choice(reasons), rng.random() < 0.4,
                     None, False))

    per_day = max(1, args.plays // days)
    for d in range(days):
        day = start + timedelta(days=d)
        if day >= today - timedelta(days=12) or rng.random() < 0.85:  # a 12-day current streak, gaps before
            for _ in range(rng.randint(max(1, per_day // 2), per_day * 2)):
                t = rng.choices(tracks, weights)[0]
                if t in tracks[:30] and rng.random() < 0.3:
                    t = variants[tracks.index(t)]
                add_play(day, rng.randint(7 * 60, 24 * 60 - 1), t)
    # Same month/day as today in every past year (On this day).
    for y in range(2019, today.year):
        try:
            d = today.replace(year=y)
        except ValueError:
            continue
        for _ in range(8):
            add_play(d, rng.randint(600, 1300), rng.choices(tracks, weights)[0])

    conn = psycopg.connect(args.db)
    cur = conn.cursor()
    with cur.copy("COPY spotify_plays (played_at, ms_played, platform, country, track_uri, track_name, artist_name, album_name, reason_end, shuffle, skipped, offline) FROM STDIN") as cp:
        for r in rows:
            cp.write_row(r)
    print(f"[seed] {len(rows)} plays over {days} days")

    # ── metadata, liked, scores ──
    for t in every:
        canonical = t.get("single_of") or t["uri"]
        cur.execute(
            """INSERT INTO track_metadata (track_uri, release_date, release_year, release_date_precision, duration_ms, popularity,
                   explicit, album_id, artist_ids, artist_names, isrc, album_type, canonical_track_uri)
               VALUES (%s,%s,%s,'day',%s,%s,false,%s,%s,%s,%s,%s,%s)""",
            (t["uri"], f"{t['year']}-0{rng.randint(1, 9)}-1{rng.randint(0, 9)}", t["year"], t["duration_ms"], rng.randint(10, 80),
             t["album"]["id"], [a["id"] for a in t["artists"]], [a["name"] for a in t["artists"]], t["isrc"],
             "single" if t.get("single_of") else "album", canonical))
    for t in rng.sample(tracks, 80):
        cur.execute("INSERT INTO liked_songs (track_uri, liked_at, track_name, artist_name, album_name) VALUES (%s, now() - interval '200 days', %s, %s, %s)",
                    (t["uri"], t["name"], t["artists"][0]["name"], t["album"]["name"]))
    for t in tracks:
        cur.execute(
            """INSERT INTO track_popularity_scores (track_uri, raw_plays, sticky_pct, evergreen_pct, flash_hit_pct, session_loop_pct, composite_score)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (t["uri"], rng.randint(1, 900), round(rng.random(), 4), round(rng.random(), 4), round(rng.random(), 4), round(rng.random(), 4), round(rng.random(), 4)))
    for a in artists:
        cur.execute(
            """INSERT INTO artist_popularity_scores (artist_name, total_plays, sticky_pct, evergreen_pct, depth_pct, saved_count_pct, composite_score)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (a["name"], rng.randint(10, 9000), round(rng.random(), 4), round(rng.random(), 4), round(rng.random(), 4), round(rng.random(), 4), round(rng.random(), 4)))

    # ── badges (tracks + artists) ──
    for k, t in enumerate(tracks[:12]):
        cur.execute("INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context) VALUES ('track', %s, 'plays_50', now() - %s * interval '3 days', '{}')", (t["uri"], k))
    cur.execute("""INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
                   VALUES ('track', %s, 'top_1st_month', now() - interval '1 day', %s)""",
                (tracks[0]["uri"], json.dumps({"window": today.strftime("%Y-%m"), "plays_in_window": 41, "rank_2_gap": 6})))
    cur.execute("""INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
                   VALUES ('track', %s, 'plays_20_in_day', now() - interval '2 hours', %s)""",
                (variants[0]["uri"], json.dumps({"window": str(today), "plays_that_day": 22})))
    cur.execute("""INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
                   VALUES ('artist', %s, 'artist_plays_1000', now() - interval '5 hours', %s)""",
                (artists[0]["id"], json.dumps({"total_plays": 1200, "distinct_tracks_played": 40})))

    # ── playlists: DB mirror + Spotify mock ──
    now = datetime.now(timezone.utc)
    pls = {}

    def playlist(name, owner=OWNER, kind=None, items=None, collab=False):
        pid = sid()
        pls[pid] = {"id": pid, "name": name, "owner": owner, "collaborative": collab, "public": False,
                    "items": items if items is not None else [t["uri"] for t in rng.sample(tracks, 25)], "snapshot_id": f"snap-{pid[:4]}-1"}
        cur.execute(
            """INSERT INTO spotify_playlists (playlist_id, name, owner_id, owner_name, is_owned, is_collab, is_public, managed_kind,
                   snapshot_id, track_count, image_url, first_seen_at, last_seen_at, synced_by)
               VALUES (%s,%s,%s,%s,%s,%s,false,%s,%s,%s,NULL,now() - interval '30 days',now(),'python')""",
            (pid, name, owner, "E2E Owner" if owner == OWNER else "Someone else", owner == OWNER, collab, kind, pls[pid]["snapshot_id"], len(pls[pid]["items"])))
        return pid

    top30 = playlist("Top 30 last 30 days · Auto 🤖🔄", kind="auto_updating")
    playlist("Forgotten favorites · Auto 🤖🔄", kind="auto_updating")
    playlist("Missed new tracks · popular artists · Auto 🤖🔄", kind="auto_updating")
    playlist("My Monthly #1 · Auto 🤖🔄", kind="auto_updating")
    snap = playlist(f"Top 25 · {(today.replace(day=1) - timedelta(days=1)).strftime('%B %Y')} · Auto 🤖📸", kind="auto_snapshot")
    custom = playlist("Late night · Custom 🎧", kind="custom")
    road = playlist("Road trip")
    followed = playlist("Hardstyle Classics", owner=OTHER)
    spoof = playlist("Fake · Custom 🎧 (copy)")
    stolen = playlist("Stolen · Auto 🤖🔄", owner=OTHER)
    cur.execute("UPDATE spotify_playlists SET managed_kind = NULL WHERE playlist_id IN (%s, %s)", (spoof, stolen))
    for pid, p in pls.items():
        if p["owner"] == OWNER:
            for pos, u in enumerate(p["items"]):
                t = next(x for x in every if x["uri"] == u)
                cur.execute("INSERT INTO spotify_playlist_items (playlist_id, position, track_uri, track_name, artist_name, duration_ms, added_at) VALUES (%s,%s,%s,%s,%s,%s,now())",
                            (pid, pos, u, t["name"], ", ".join(a["name"] for a in t["artists"]), t["duration_ms"]))
            cur.execute("UPDATE spotify_playlists SET items_snapshot_id = snapshot_id, items_synced_at = now() WHERE playlist_id = %s", (pid,))
    filters = {"artists": [artists[0]["name"]], "release_year_min": None, "release_year_max": None, "discovery_year_min": None,
               "discovery_year_max": None, "min_plays": None, "max_tracks": 25, "liked_only": False, "sort_order": "plays_desc"}
    cur.execute("""INSERT INTO custom_playlists (playlist_id, name, expires_at, track_count, filters_summary, filters_json, excluded_uris)
                   VALUES (%s, %s, now() + interval '3 days', 25, 'artists=…', %s, '{}')""", (custom, pls[custom]["name"], json.dumps(filters)))
    for pid in (top30, snap):
        cur.execute("INSERT INTO playlist_settings (playlist_id, playlist_name, order_pref) VALUES (%s, %s, 'default')", (pid, pls[pid]["name"]))
    cur.execute("INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_label) VALUES (%s, %s, %s, 'E2E phone')",
                ("https://push.example.invalid/e2e-seeded", "B" + "A" * 86, "A" * 22))
    conn.commit()

    # Real rules catalog + daily picks (same code the crons run).
    try:
        from lib.rules_catalog import export_rules_catalog
        print(f"[seed] rules catalog: {export_rules_catalog(conn)}")
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        print(f"[seed] WARNING rules catalog: {e}")
    try:
        from lib import daily_picks
        r = daily_picks.generate(conn, today)
        print(f"[seed] daily picks: {r.status}, {len(r.deck)} candidates")
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        print(f"[seed] WARNING daily picks: {e}")
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM daily_pick_candidates WHERE pick_date = %s", (today,))
    have = cur.fetchone()[0]
    for rank in range(have + 1, 6):  # top up to 5 so the R1 deck checks are deterministic
        sample = [t["uri"] for t in rng.sample(tracks, 20)]
        cur.execute("""INSERT INTO daily_pick_candidates (pick_date, rank, kind, recipe, title, reason, track_uris, duration_ms, score)
                       VALUES (%s, %s, 'generated', 'evergreen_core', %s, 'E2E seeded pick', %s, 4000000, 0.5)""",
                    (today, rank, f"E2E pick {rank}", sample))
    conn.commit()

    # ── R7 Release radar: Spotify artist albums, MusicBrainz, Scantraxx pages (dates relative to today) ──
    # Generated after every other rng use, so the rest of the seed stays identical.
    played = {r[4] for r in rows}
    a0, a1 = artists[0], artists[2]                      # Da Tweekaz, Headhunterz
    lib_track = next(t for t in tracks if t["uri"] in played and t["artists"][0]["id"] not in (a0["id"], a1["id"]))
    a2 = lib_track["artists"][0]
    followed_artist = {"id": sid(), "name": "E2E Followed Artist"}
    ids = {k: sid() for k in ("fresh", "older", "shared", "lib", "followed")}
    new_t = [f"spotify:track:{sid()}" for _ in range(5)]

    def dd(n: int) -> date:
        return today + timedelta(days=n)

    def album(aid, name, n, kind, artist):
        return {"album_type": kind, "id": aid, "name": name, "release_date": dd(n).isoformat(), "release_date_precision": "day",
                "external_urls": {"spotify": f"https://open.spotify.com/album/{aid}"}, "artists": [{"id": artist["id"], "name": artist["name"]}]}

    artist_albums = {
        a0["id"]: [album(ids["fresh"], "E2E Fresh Single", -3, "single", a0), album(ids["older"], "E2E Older Album", -40, "album", a0)],
        a1["id"]: [album(ids["shared"], "Shared Release", -5, "single", a1)],
        a2["id"]: [album(ids["lib"], "Already Yours", -8, "single", a2)],
        followed_artist["id"]: [album(ids["followed"], "Followed Drop", -2, "single", followed_artist)],
    }
    album_tracks = {ids["fresh"]: new_t[:2], ids["older"]: [new_t[2]], ids["shared"]: [new_t[3]], ids["lib"]: [lib_track["uri"]],
                    ids["followed"]: [new_t[4]]}
    musicbrainz = {
        "bySpotify": {a1["id"]: {"mbid": "mb-e2e-headhunterz", "name": a1["name"]}},
        "releases": {"mb-e2e-headhunterz": [
            {"id": "r-e2e-1", "title": "Shared Release (Extended Mix)", "date": dd(-5).isoformat(),
             "release-group": {"id": "rg-e2e-shared", "title": "Shared Release", "primary-type": "Single"},
             "label-info": [{"label": {"name": "Scantraxx"}}]},
            {"id": "r-e2e-2", "title": "E2E Future Album", "date": dd(20).isoformat(),
             "release-group": {"id": "rg-e2e-future", "title": "E2E Future Album", "primary-type": "Album"}, "label-info": []},
        ]},
    }
    months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    lines: dict[str, list[tuple[date, str, str]]] = {}
    for when, artist, title in ((dd(0), a1["name"], "Shared Release"), (dd(10), a0["name"], "E2E Label Exclusive"),
                                (dd(1), "Not Your Artist", "Never On The Radar")):
        lines.setdefault(f"{months[when.month - 1]}-{when.year}", []).append((when, artist, title))
    lines.setdefault(f"{months[today.month - 1]}-{today.year}", [])
    scantraxx = {}
    for key, items in lines.items():
        # The real page's release cards (tests/fixtures/release_radar/scantraxx_live_october_2026.html).
        body = "".join(
            f'<div class="trackItem"><div class="innerTrack"><div class="bottomInfo"><div class="artistsInfo">{html.escape(a)}</div>'
            f'<a class="trackLink hideCustomCursor" title="{html.escape(t)}" href="/releases/{90000 + i}/e2e"><span class="label">'
            f'<span class="innerLabel">{html.escape(t)}</span></span></a><div class="version"></div><div class="bottomCols">'
            f'<div class="trackLabel">Scantraxx</div><div class="date">{w.day:02d} / {w.month:02d} / {w.year}</div></div></div></div></div>'
            for i, (w, a, t) in enumerate(sorted(items)))
        scantraxx[key] = (f"<!doctype html><html><head><title>Releases Scantraxx | {key}</title></head><body><nav><a href='/'>Home</a></nav>"
                          f"<main><h1 class='subTitle'>Week 1</h1>{body}</main><footer>© Scantraxx</footer></body></html>")

    # ── v0.90 Artist pages (beta): the Spotify catalog mock. No rng here (keeps every fixture above stable). ──
    catalog = build_catalog(artists[0], tracks, variants)

    state = {
        "owner": OWNER,
        "loginUser": None,
        "libraryModifyGranted": True,
        "playlists": pls,
        "library": list(pls.keys()),
        "tracks": {t["uri"]: {"name": t["name"], "artists": t["artists"], "album": t["album"], "duration_ms": t["duration_ms"]} for t in every},
        "devices": [
            {"id": "dev-iphone", "name": "iPhone", "type": "Smartphone", "is_active": True, "is_restricted": False, "supports_volume": False, "volume_percent": None},
            {"id": "dev-speaker", "name": "Living room", "type": "Speaker", "is_active": False, "is_restricted": False, "supports_volume": True, "volume_percent": 40},
        ],
        "playback": {"device_id": "dev-iphone", "is_playing": False, "item_uri": tracks[0]["uri"], "progress_ms": 30000, "context_uri": f"spotify:playlist:{top30}",
                     "list": pls[top30]["items"], "index": 0},
        "unfollowed": [],
        "dispatches": [],
        # R4: a 23-video unlisted YouTube playlist (#6 not embeddable, #23 deleted) + a SoundCloud set.
        "youtube": {
            "playlists": {"PLe2eRotorTestList01": {"title": "E2E hardstyle mix", "channel": "E2E Channel",
                                                   "items": [f"e2eVid{n:05d}" for n in range(1, 24)]}},
            "videos": {f"e2eVid{n:05d}": {"title": f"E2E video {n}", "channel": "E2E Channel", "duration": "PT3M20S",
                                          "embeddable": n != 6} for n in range(1, 23)},
        },
        "soundcloud": {"https://soundcloud.com/e2e-artist/sets/e2e-set": {"title": "E2E SoundCloud set", "author": "e2e-artist"}},
        "artistAlbums": artist_albums,
        "albumTracks": album_tracks,
        "musicbrainz": musicbrainz,
        "musicbrainzDown": False,
        "scantraxx": scantraxx,
        "catalog": catalog,
        "fixture": {"top30": top30, "snapshot": snap, "custom": custom, "road": road, "followed": followed, "spoof": spoof, "stolen": stolen,
                    "artist0": artists[0], "track0": tracks[0]["uri"], "variant0": variants[0]["uri"], "today": str(today),
                    "radar": {"a0": a0, "a1": a1, "a2": a2, "followed": followed_artist, "albums": ids, "newTracks": new_t,
                              "libTrack": lib_track["uri"]},
                    "catalog": catalog["fixture"]},
    }
    Path(args.state).parent.mkdir(parents=True, exist_ok=True)
    Path(args.state).write_text(json.dumps(state))
    conn.close()
    print(f"[seed] state → {args.state}")
    return 0


SYNTH = {  # id → (name, releases per include_groups value): the small / medium / very large mock artists
    "SynthSmall000000000020": ("Synth Small", {"album": 2, "single": 10, "compilation": 1, "appears_on": 7}),
    "SynthMedium00000000150": ("Synth Medium", {"album": 10, "single": 60, "compilation": 5, "appears_on": 75}),
    "SynthLarge000000000600": ("Synth Large", {"album": 15, "single": 150, "compilation": 15, "appears_on": 420}),
    "SynthFresh000000000003": ("Synth Fresh", {"album": 1, "single": 2, "compilation": 0, "appears_on": 0}),
}


def _cover(seed: str) -> list:
    import hashlib
    h = hashlib.sha1(seed.encode()).hexdigest()
    return [{"url": f"https://i.scdn.co/image/ab67616d0000{code}{h}", "width": w, "height": w}
            for code, w in (("b273", 640), ("1e02", 300), ("4851", 64))]


def build_catalog(artist0: dict, tracks: list, variants: list) -> dict:
    """artist0 (seeded plays): one explicit release per album of its tracks + single versions + one
    compilation it appears on + one release never heard. Synthetic artists are generated by the mock."""
    a0 = {"id": artist0["id"], "name": artist0["name"]}
    albums: dict = {}
    explicit = {"album": [], "single": [], "compilation": [], "appears_on": []}

    def track_obj(tid: str, name: str, n: int, dur: int, credit: list) -> dict:
        return {"id": tid, "uri": f"spotify:track:{tid}", "name": name, "track_number": n, "disc_number": 1,
                "duration_ms": dur, "artists": [{"id": c["id"], "name": c["name"]} for c in credit]}

    def add(group: str, album_id: str, name: str, album_type: str, date_: str, track_list: list, credit: list) -> None:
        albums[album_id] = {"id": album_id, "name": name, "album_type": album_type, "total_tracks": len(track_list),
                            "release_date": date_, "release_date_precision": "day", "images": _cover(album_id),
                            "artists": credit, "uri": f"spotify:album:{album_id}", "tracks": track_list}
        explicit[group].append(album_id)

    mine = [t for t in tracks if t["artists"][0]["id"] == a0["id"]]
    for t in mine:
        tid = t["uri"].split(":")[2]
        fill = [track_obj(f"F{t['album']['id'][1:19]}{k:02d}x", f"{t['album']['name']} – bonus {k}", k + 1, 190_000, [a0]) for k in range(1, 4)]
        add("album", t["album"]["id"], t["album"]["name"], "album", f"{t['year']}-06-01",
            [track_obj(tid, t["name"], 1, t["duration_ms"], t["artists"])] + fill, [a0])
    for v in variants:
        if v["artists"][0]["id"] == a0["id"]:
            add("single", v["album"]["id"], v["album"]["name"], "single", f"{v['year']}-03-01",
                [track_obj(v["uri"].split(":")[2], v["name"], 1, v["duration_ms"], v["artists"])], [a0])
    # A compilation by others with ONE track of artist0 (played: it is a seeded canonical track).
    played = mine[0]
    comp_id = "CompE2EVariousVol00001"
    guests = [{"id": f"GuestE2E{k:02d}{'q' * 12}", "name": f"Guest DJ {k}"} for k in range(1, 9)]
    comp_tracks = [track_obj(f"CompE2ETrack{k:02d}{'c' * 8}", f"Guest anthem {k}", k, 200_000, [guests[k - 1]]) for k in range(1, 9)]
    comp_tracks.insert(3, track_obj(played["uri"].split(":")[2], played["name"], 4, played["duration_ms"], played["artists"]))
    for k, t in enumerate(comp_tracks):
        t["track_number"] = k + 1
    add("appears_on", comp_id, "Hardstyle Top 100 – E2E Edition", "compilation", "2024-12-06", comp_tracks, [{"id": None, "name": "Various Artists"}])
    # Never heard: a brand-new single.
    add("single", "NewSingleE2E0000000001", f"{a0['name']} – Brand New", "single", "2026-10-30",
        [track_obj("NewSingleE2ETrack00001", "Brand New", 1, 210_000, [a0])], [a0])

    artists_ = {a0["id"]: {"name": a0["name"], "explicit": explicit}}
    for sid_, (name, gen) in SYNTH.items():
        artists_[sid_] = {"name": name, "gen": gen}
    return {
        "artists": artists_, "albums": albums, "fail429": 0, "retryAfter": 1, "searchPool": ["SynthMedium00000000150"],
        "fixture": {"artist0": a0["id"], "comp": comp_id, "compOwnTrack": played["uri"], "newSingle": "NewSingleE2E0000000001",
                    "ownAlbums": len(explicit["album"]), "ownSingles": len(explicit["single"]),
                    "synth": {k: sum(v[1].values()) for k, v in SYNTH.items()}},
    }


if __name__ == "__main__":
    sys.exit(main())
