import argparse
import sys
import time
from datetime import datetime, timezone

import psycopg

sys.path.insert(0, ".")
from lib.db import get_connection
from lib.lastfm import LastfmClient

SOURCE = "lastfm"
COMMIT_EVERY = 500
MAX_RETRIES = 3


def _or_none(val: str) -> str | None:
    return val if val else None


def resolve_artist(cur: psycopg.Cursor, name: str, mbid: str | None) -> int:
    if mbid:
        cur.execute("SELECT id FROM artists WHERE mbid = %s", (mbid,))
        row = cur.fetchone()
        if row:
            return row[0]

    cur.execute("SELECT id FROM artists WHERE lower(name) = lower(%s)", (name,))
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        "INSERT INTO artists (name, mbid) VALUES (%s, %s) RETURNING id",
        (name, mbid),
    )
    return cur.fetchone()[0]


def resolve_album(
    cur: psycopg.Cursor, artist_id: int, title: str, mbid: str | None
) -> int | None:
    if not title:
        return None

    if mbid:
        cur.execute("SELECT id FROM albums WHERE mbid = %s", (mbid,))
        row = cur.fetchone()
        if row:
            return row[0]

    cur.execute(
        "SELECT id FROM albums WHERE artist_id = %s AND lower(title) = lower(%s)",
        (artist_id, title),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        "INSERT INTO albums (artist_id, title, mbid) VALUES (%s, %s, %s) RETURNING id",
        (artist_id, title, mbid),
    )
    return cur.fetchone()[0]


def resolve_track(
    cur: psycopg.Cursor,
    artist_id: int,
    album_id: int | None,
    title: str,
    mbid: str | None,
) -> int:
    if mbid:
        cur.execute("SELECT id FROM tracks WHERE mbid = %s", (mbid,))
        row = cur.fetchone()
        if row:
            return row[0]

    cur.execute(
        "SELECT id FROM tracks WHERE artist_id = %s AND lower(title) = lower(%s)",
        (artist_id, title),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        "INSERT INTO tracks (artist_id, album_id, title, mbid) VALUES (%s, %s, %s, %s) RETURNING id",
        (artist_id, album_id, title, mbid),
    )
    return cur.fetchone()[0]


def get_delta_ts(cur: psycopg.Cursor) -> int | None:
    cur.execute(
        "SELECT EXTRACT(EPOCH FROM MAX(played_at))::BIGINT FROM scrobbles WHERE source = %s",
        (SOURCE,),
    )
    row = cur.fetchone()
    return row[0] if row and row[0] is not None else None


def get_backfill_to_ts(cur: psycopg.Cursor) -> int | None:
    cur.execute(
        "SELECT EXTRACT(EPOCH FROM MIN(played_at))::BIGINT FROM scrobbles WHERE source = %s",
        (SOURCE,),
    )
    row = cur.fetchone()
    return row[0] if row and row[0] is not None else None


def process_track(cur: psycopg.Cursor, track: dict) -> bool:
    artist_name = track["artist"]["#text"]
    artist_mbid = _or_none(track["artist"].get("mbid", ""))
    track_title = track["name"]
    track_mbid = _or_none(track.get("mbid", ""))
    album_title = _or_none(track["album"]["#text"])
    album_mbid = _or_none(track["album"].get("mbid", ""))
    played_at_ts = int(track["date"]["uts"])

    artist_id = resolve_artist(cur, artist_name, artist_mbid)
    album_id = resolve_album(cur, artist_id, album_title or "", album_mbid) if album_title else None
    track_id = resolve_track(cur, artist_id, album_id, track_title, track_mbid)

    cur.execute(
        """
        INSERT INTO scrobbles (track_id, played_at, source)
        VALUES (%s, to_timestamp(%s), %s)
        ON CONFLICT (source, played_at, track_id) DO NOTHING
        """,
        (track_id, played_at_ts, SOURCE),
    )
    return cur.rowcount == 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest last.fm scrobbles into Postgres")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--backfill", action="store_true", help="Fetch full history (default)")
    mode.add_argument("--delta", action="store_true", help="Fetch only scrobbles newer than latest in DB")
    args = parser.parse_args()

    client = LastfmClient()
    conn = get_connection()

    from_ts: int | None = None
    to_ts: int | None = None

    if args.backfill:
        with conn.cursor() as cur:
            to_ts = get_backfill_to_ts(cur)
        if to_ts is not None:
            iso = datetime.fromtimestamp(to_ts, tz=timezone.utc).isoformat()
            print(f"Backfill resuming — fetching scrobbles older than {iso}")
        else:
            print("Full backfill from time 0")
    elif args.delta:
        with conn.cursor() as cur:
            from_ts = get_delta_ts(cur)
        if from_ts:
            print(f"Delta run: fetching scrobbles after Unix timestamp {from_ts}")
        else:
            print("Delta run: no existing scrobbles found, fetching full history")

    processed = inserted = duplicates = 0
    cur = conn.cursor()

    for track in client.fetch_recent_tracks(from_ts=from_ts, to_ts=to_ts):
        for attempt in range(MAX_RETRIES + 1):
            try:
                was_inserted = process_track(cur, track)
                break
            except psycopg.OperationalError:
                if attempt == MAX_RETRIES:
                    raise
                print(f"Connection dropped, reconnecting (attempt {attempt + 1}/{MAX_RETRIES})...")
                time.sleep(5)
                try:
                    cur.close()
                    conn.close()
                except Exception:
                    pass
                conn = get_connection()
                cur = conn.cursor()

        processed += 1
        inserted += int(was_inserted)
        duplicates += int(not was_inserted)

        if processed % COMMIT_EVERY == 0:
            conn.commit()
            print(f"Processed {processed} scrobbles ({inserted} inserted, {duplicates} duplicates)")

    conn.commit()
    cur.close()
    conn.close()
    print(f"Done. {processed} scrobbles processed ({inserted} inserted, {duplicates} duplicates).")


if __name__ == "__main__":
    main()
