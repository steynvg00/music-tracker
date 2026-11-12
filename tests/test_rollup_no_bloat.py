"""v0.92 (migration 0035): the daily full rebuild of the day rollups must not grow the tables.

On a production-sized throwaway database (≥ 450k plays, 30k tracks, 7k artists) with autovacuum OFF
on the day tables (so nothing but the function's own writes counts):
  1. hub.refresh_rollups(true) five times → hub.day_track / daily_listening / behaviour_daily keep
     their size, and the merge reports 0 rows written after the first run;
  2. new plays on one day → only that day's rows are written;
  3. control: the pre-0035 delete + insert (0026's hub.rebuild_days) grows day_track by ~a full copy per
     run, so this test would catch a regression.
Set ROLLUP_BLOAT_OUT=<file.json> to keep the measurements (the v0.92 PR quotes them).
"""
import json
import os
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TABLES = ["hub.day_track", "hub.daily_listening", "hub.behaviour_daily"]


@pytest.fixture(scope="module")
def big_db(pg_url):
    import psycopg

    base = pg_url.rsplit("/", 1)[0]
    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS rollup_bloat")
        c.execute("CREATE DATABASE rollup_bloat")
    url = f"{base}/rollup_bloat"
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("SET rotor.scrobbles_archived_rows = '0'")
        seeded = False
        for f in sorted((ROOT / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")):
            if int(f.name[:4]) == 23 and not seeded:
                _seed(conn)  # like production: the rollups are created on a populated database
                seeded = True
            conn.execute(f.read_text())
        # The pre-0035 function, kept under another name, as the control.
        src = (ROOT / "migrations" / "0026_rollups_duration_fallback.sql").read_text()
        old = re.search(r"CREATE OR REPLACE FUNCTION hub\.rebuild_days\(p_from date\).*?\n\$\$;", src, re.S).group(0)
        conn.execute(old.replace("hub.rebuild_days(", "hub.rebuild_days_old("))
        for t in TABLES:
            conn.execute(f"ALTER TABLE {t} SET (autovacuum_enabled = false)")
    yield url
    with psycopg.connect(pg_url, autocommit=True) as c:
        c.execute("DROP DATABASE IF EXISTS rollup_bloat WITH (FORCE)")


def _seed(conn):
    conn.execute("""
        INSERT INTO track_metadata (track_uri, release_date, release_year, release_date_precision, duration_ms, album_id, artist_ids, artist_names, canonical_track_uri)
        SELECT 'spotify:track:' || lpad(g::text, 22, 'T'), '2020-01-01', 2020, 'day', 150000 + (g % 180) * 1000,
               'A' || lpad((g % 9000)::text, 21, '0'), ARRAY['R' || lpad((g % 7000)::text, 21, '0')], ARRAY['Artist ' || (g % 7000)],
               'spotify:track:' || lpad(g::text, 22, 'T')
        FROM generate_series(1, 30000) g""")
    # ≥ 450k plays over ~9 years, Zipf-ish (low track numbers far more often); 1/4 without ms_played (API plays).
    conn.execute("""
        INSERT INTO spotify_plays (played_at, ms_played, platform, country, track_uri, track_name, artist_name, album_name, reason_end, shuffle)
        SELECT timestamptz '2017-01-01' + (g * 617 % 283996800) * interval '1 second',
               CASE WHEN g % 4 = 0 THEN NULL ELSE 30000 + g % 200000 END,
               (ARRAY['iOS 17.1 (iPhone15,2)', 'OS X 14.1.0 [x86 8]', 'Android OS 13 API 33', NULL])[1 + g % 4], 'NL',
               'spotify:track:' || lpad(t::text, 22, 'T'), 'Track ' || t, 'Artist ' || (t % 7000), 'Album',
               (ARRAY['trackdone', 'trackdone', 'fwdbtn', 'endplay'])[1 + g % 4], g % 3 = 0
        FROM (SELECT g, 1 + floor(30000 * power(random(), 3))::int AS t FROM generate_series(1, 460000) g) x""")


def _sizes(cur):
    out = {}
    for t in TABLES:
        cur.execute("SELECT pg_relation_size(%s::regclass), pg_total_relation_size(%s::regclass)", (t, t))
        heap, total = cur.fetchone()
        out[t] = {"heap": heap, "total": total}
    return out


def _written(merge: dict, table: str) -> int:
    m = merge[table.split(".")[1]]
    return m["deleted"] + m["updated"] + m["inserted"]


def test_full_rebuild_five_times_stays_flat_and_the_old_one_grows(big_db):
    import psycopg

    report = {"runs": []}
    with psycopg.connect(big_db, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM spotify_plays")
        plays = cur.fetchone()[0]
        assert plays >= 450_000
        report["plays"] = plays
        cur.execute("SELECT count(*) FROM hub.day_track")
        report["day_track_rows"] = cur.fetchone()[0]
        base = _sizes(cur)
        report["start"] = base
        for i in range(5):
            cur.execute("SELECT hub.refresh_rollups(true)")
            r = cur.fetchone()[0]
            s = _sizes(cur)
            report["runs"].append({"run": i + 1, "merge": r["merge"], "days_ms": r["days_ms"], "sizes": s})
            for t in TABLES:
                assert _written(r["merge"], t) == 0, (i, t, r["merge"])       # nothing changed → nothing written
                assert s[t]["total"] == base[t]["total"], (i, t, s[t], base[t])  # not one byte of growth

        # New plays on one day → only that day's rows are touched.
        cur.execute("""INSERT INTO spotify_plays (played_at, ms_played, platform, track_uri, track_name, artist_name, reason_end)
                       SELECT timestamptz '2024-05-05 12:00+00' + g * interval '1 minute', 200000, 'iOS 17.1', 'spotify:track:' || lpad((g % 50 + 1)::text, 22, 'T'),
                              'Track ' || (g % 50 + 1), 'Artist ' || ((g % 50 + 1) % 7000), 'trackdone' FROM generate_series(1, 120) g""")
        cur.execute("SELECT hub.refresh_rollups(true)")
        r = cur.fetchone()[0]
        report["one_day_changed"] = r["merge"]
        assert r["merge"]["daily_listening"]["updated"] + r["merge"]["daily_listening"]["inserted"] == 1
        assert 0 < _written(r["merge"], "hub.day_track") <= 50

        # Control: the pre-0035 delete + insert grows the table by about one copy per run.
        before = _sizes(cur)["hub.day_track"]["heap"]
        cur.execute("SELECT hub.rebuild_days_old(NULL)")
        cur.execute("SELECT hub.rebuild_days_old(NULL)")
        after = _sizes(cur)["hub.day_track"]["heap"]
        report["old_function_day_track_heap"] = {"before": before, "after_2_runs": after}
        assert after > before * 1.8

    out = os.environ.get("ROLLUP_BLOAT_OUT")
    if out:
        Path(out).write_text(json.dumps(report, indent=2))
