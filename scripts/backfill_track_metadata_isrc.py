"""One-shot backfill: populate ISRC + album_type for existing track_metadata rows,
then compute canonical_track_uri for each ISRC group.

Resumable: re-running skips tracks where isrc and album_type are already populated.
Expected runtime: ~15-20 min for ~29k tracks (50/batch, 1.1s pacing).
Apply migration 0013 before running.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os
import time
from dotenv import load_dotenv
import psycopg

from lib.spotify import get_spotify_client
from lib.track_metadata import enrich_tracks


_CANONICALIZE_SQL = """
WITH ranked AS (
    SELECT
        tm.track_uri,
        tm.isrc,
        tm.album_type,
        ROW_NUMBER() OVER (
            PARTITION BY tm.isrc
            ORDER BY
                CASE tm.album_type
                    WHEN 'album'       THEN 1
                    WHEN 'compilation' THEN 2
                    WHEN 'single'      THEN 3
                    ELSE 4
                END,
                COALESCE(
                    (SELECT COUNT(*) FROM spotify_plays sp WHERE sp.track_uri = tm.track_uri),
                    0
                ) DESC,
                COALESCE(tm.popularity, 0) ASC
        ) AS rank
    FROM track_metadata tm
    WHERE tm.isrc IS NOT NULL
),
canonical_uris AS (
    SELECT isrc, track_uri AS canonical_uri
    FROM ranked
    WHERE rank = 1
)
UPDATE track_metadata tm
SET canonical_track_uri = c.canonical_uri
FROM canonical_uris c
WHERE c.isrc = tm.isrc;
"""

_CANONICAL_SELF_SQL = """
UPDATE track_metadata
SET canonical_track_uri = track_uri
WHERE canonical_track_uri IS NULL;
"""


def get_uris_needing_isrc(conn) -> list[str]:
    """Return track_uris from track_metadata where isrc or album_type is missing."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT track_uri
        FROM track_metadata
        WHERE isrc IS NULL OR album_type IS NULL
        ORDER BY track_uri
        """
    )
    return [row[0] for row in cur.fetchall()]


def run_canonicalization(conn) -> None:
    print("\n[backfill-isrc] Running canonicalization (Phase A: ISRC groups)...", flush=True)
    cur = conn.cursor()
    cur.execute(_CANONICALIZE_SQL)
    phase_a_updated = cur.rowcount
    print(f"[backfill-isrc] Phase A: updated {phase_a_updated} rows.", flush=True)

    print("[backfill-isrc] Running canonicalization (Phase B: self-referential for no-ISRC tracks)...", flush=True)
    cur.execute(_CANONICAL_SELF_SQL)
    phase_b_updated = cur.rowcount
    print(f"[backfill-isrc] Phase B: updated {phase_b_updated} rows.", flush=True)

    conn.commit()
    cur.close()


def print_verification(conn) -> None:
    cur = conn.cursor()

    # Coverage
    cur.execute("SELECT COUNT(*) FROM track_metadata WHERE isrc IS NOT NULL AND album_type IS NOT NULL")
    enriched_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM track_metadata WHERE isrc IS NULL")
    null_isrc_count = cur.fetchone()[0]

    print("\n=== Coverage report ===", flush=True)
    print(f"Tracks enriched with ISRC + album_type: {enriched_count:,}", flush=True)
    print(f"Tracks with NULL ISRC (unexpected): {null_isrc_count:,} — should be 0 or very low", flush=True)

    # ISRC group statistics
    cur.execute("SELECT COUNT(DISTINCT isrc) FROM track_metadata WHERE isrc IS NOT NULL")
    total_isrcs = cur.fetchone()[0]

    cur.execute("""
        WITH counts AS (
            SELECT isrc, COUNT(*) AS n
            FROM track_metadata WHERE isrc IS NOT NULL
            GROUP BY isrc
        )
        SELECT
            SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS exactly_one,
            SUM(CASE WHEN n = 2 THEN 1 ELSE 0 END) AS exactly_two,
            SUM(CASE WHEN n >= 3 THEN 1 ELSE 0 END) AS three_or_more,
            SUM(CASE WHEN n > 1 THEN n ELSE 0 END) AS affected_tracks
        FROM counts
    """)
    row = cur.fetchone()
    exactly_one, exactly_two, three_or_more, affected_tracks = row

    print("\n=== ISRC group statistics ===", flush=True)
    print(f"Total distinct ISRC values: {total_isrcs:,}", flush=True)
    print(f"ISRCs with exactly 1 track_uri: {exactly_one:,}", flush=True)
    print(f"ISRCs with 2 track_uris: {exactly_two:,}", flush=True)
    print(f"ISRCs with 3+ track_uris: {three_or_more:,}", flush=True)
    print(f"Total tracks affected by canonicalization (group size > 1): {affected_tracks or 0:,}", flush=True)

    # album_type distribution
    cur.execute("""
        SELECT COALESCE(album_type, 'NULL') AS at, COUNT(*) AS n
        FROM track_metadata
        GROUP BY album_type
        ORDER BY n DESC
    """)
    print("\n=== album_type distribution ===", flush=True)
    for at, n in cur.fetchall():
        print(f"{at}: {n:,}", flush=True)

    # Top 10 most-duplicated ISRCs
    cur.execute("""
        SELECT
            tm.isrc,
            COUNT(*) AS uri_count,
            MAX(tm.canonical_track_uri) AS canonical_uri
        FROM track_metadata tm
        WHERE tm.isrc IS NOT NULL
        GROUP BY tm.isrc
        HAVING COUNT(*) > 1
        ORDER BY uri_count DESC
        LIMIT 10
    """)
    dup_rows = cur.fetchall()

    print("\n=== Top 10 most-duplicated ISRCs (sample) ===", flush=True)
    for isrc, uri_count, canonical_uri in dup_rows:
        cur.execute(
            "SELECT MAX(track_name), MAX(artist_name) FROM spotify_plays WHERE track_uri = %s",
            (canonical_uri,),
        )
        name_row = cur.fetchone()
        track_label = f"{name_row[1]} - {name_row[0]}" if name_row and name_row[0] else canonical_uri
        print(f"{isrc} | {uri_count} URIs | sample canonical: {track_label}", flush=True)

    # Synchronised validation — find tracks from the Synchronised album
    cur.execute("""
        SELECT
            tm.track_uri,
            (SELECT MAX(sp.track_name) FROM spotify_plays sp WHERE sp.track_uri = tm.track_uri) AS track_name,
            (SELECT MAX(sp.album_name) FROM spotify_plays sp WHERE sp.track_uri = tm.track_uri) AS album_name,
            tm.isrc,
            tm.album_type,
            tm.canonical_track_uri
        FROM track_metadata tm
        WHERE EXISTS (
            SELECT 1 FROM spotify_plays sp
            WHERE sp.track_uri = tm.track_uri
              AND sp.album_name ILIKE '%Synchronised%'
        )
          AND tm.isrc IN (
              SELECT tm2.isrc FROM track_metadata tm2
              WHERE tm2.isrc IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM spotify_plays sp2
                    WHERE sp2.track_uri = tm2.track_uri
                      AND sp2.album_name ILIKE '%Synchronised%'
                )
              GROUP BY tm2.isrc
              HAVING COUNT(*) > 1
          )
        ORDER BY tm.isrc, tm.album_type
    """)
    sync_rows = cur.fetchall()

    print("\n=== Synchronised validation ===", flush=True)
    if sync_rows:
        for track_uri, track_name, album_name, isrc, album_type, canonical_uri in sync_rows:
            print(
                f"{track_uri} | {track_name} | {album_name} | "
                f"isrc={isrc} | album_type={album_type} | canonical={canonical_uri}",
                flush=True,
            )
        isrcs_shown = {r[3] for r in sync_rows}
        for isrc in isrcs_shown:
            uris = [r[0] for r in sync_rows if r[3] == isrc]
            canonicals = {r[5] for r in sync_rows if r[3] == isrc}
            if len(canonicals) == 1:
                print(f"  ✓ ISRC {isrc}: all {len(uris)} URIs resolve to the same canonical.", flush=True)
            else:
                print(f"  ✗ ISRC {isrc}: multiple canonicals detected — review needed.", flush=True)
    else:
        print("  No multi-URI Synchronised tracks found (either all are unique or album not in plays).", flush=True)

    cur.close()


def main():
    load_dotenv()

    print("[backfill-isrc] Getting Spotify client...", flush=True)
    sp = get_spotify_client()

    db_url = os.environ["DATABASE_URL"]
    print("[backfill-isrc] Opening DB connection...", flush=True)
    conn = psycopg.connect(db_url)

    try:
        print("[backfill-isrc] Querying tracks needing ISRC / album_type...", flush=True)
        uris = get_uris_needing_isrc(conn)
        total = len(uris)
        print(f"[backfill-isrc] {total:,} tracks need ISRC enrichment.", flush=True)

        if total > 0:
            print(
                f"[backfill-isrc] Enriching via enrich_tracks() "
                f"({(total + 49) // 50} batches of 50, 1.1s pacing)...",
                flush=True,
            )
            t0 = time.time()
            result = enrich_tracks(sp, conn, uris)
            elapsed = time.time() - t0
            print(
                f"\n[backfill-isrc] Enrichment done. "
                f"Enriched {result['enriched']:,}/{result['requested']:,} "
                f"({result['failed']} failed) in {elapsed:.1f}s.",
                flush=True,
            )
        else:
            print("[backfill-isrc] All tracks already have ISRC + album_type. Skipping enrichment.", flush=True)

        run_canonicalization(conn)
        print_verification(conn)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
