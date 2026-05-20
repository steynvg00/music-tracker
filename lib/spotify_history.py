"""Parsing and ingestion library for Spotify Extended Streaming History JSON exports."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

_FIELD_MAP = {
    "ts":                                "played_at",
    "ms_played":                         "ms_played",
    "platform":                          "platform",
    "conn_country":                      "country",
    "spotify_track_uri":                 "track_uri",
    "master_metadata_track_name":        "track_name",
    "master_metadata_album_artist_name": "artist_name",
    "master_metadata_album_album_name":  "album_name",
    "spotify_episode_uri":               "episode_uri",
    "episode_name":                      "episode_name",
    "episode_show_name":                 "show_name",
    "audiobook_uri":                     "audiobook_uri",
    "audiobook_title":                   "audiobook_title",
    "audiobook_chapter_uri":             "audiobook_chapter_uri",
    "audiobook_chapter_title":           "audiobook_chapter_title",
    "reason_start":                      "reason_start",
    "reason_end":                        "reason_end",
    "shuffle":                           "shuffle",
    "skipped":                           "skipped",
    "offline":                           "offline",
    "offline_timestamp":                 "offline_timestamp",
    "incognito_mode":                    "incognito_mode",
}

_INSERT_SQL = """
    INSERT INTO spotify_plays (
        played_at, ms_played, platform, country,
        track_uri, track_name, artist_name, album_name,
        episode_uri, episode_name, show_name,
        audiobook_uri, audiobook_title, audiobook_chapter_uri, audiobook_chapter_title,
        reason_start, reason_end,
        shuffle, skipped, offline, offline_timestamp, incognito_mode
    ) VALUES (
        %(played_at)s, %(ms_played)s, %(platform)s, %(country)s,
        %(track_uri)s, %(track_name)s, %(artist_name)s, %(album_name)s,
        %(episode_uri)s, %(episode_name)s, %(show_name)s,
        %(audiobook_uri)s, %(audiobook_title)s, %(audiobook_chapter_uri)s, %(audiobook_chapter_title)s,
        %(reason_start)s, %(reason_end)s,
        %(shuffle)s, %(skipped)s, %(offline)s, %(offline_timestamp)s, %(incognito_mode)s
    )
    ON CONFLICT DO NOTHING
"""


def _normalize(raw: dict) -> dict:
    record = {}
    for src_key, db_col in _FIELD_MAP.items():
        record[db_col] = raw.get(src_key)

    ts = record.get("played_at")
    if isinstance(ts, str):
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        record["played_at"] = dt

    return record


def parse_json_file(path: Path) -> list[dict]:
    """Parse a Spotify Extended history JSON file into a list of normalized record dicts."""
    with open(path, encoding="utf-8") as fh:
        raw_list = json.load(fh)
    return [_normalize(entry) for entry in raw_list]


def records_from_directory(directory: Path) -> Iterator[tuple[Path, list[dict]]]:
    """Yield (file_path, parsed_records) for each *.json file in the directory, sorted by filename."""
    for path in sorted(directory.glob("*.json")):
        yield path, parse_json_file(path)


def ingest_records(conn, records: list[dict], dry_run: bool = False) -> dict:
    """Bulk-insert records into spotify_plays. Returns dict with keys: attempted, inserted, skipped.

    Uses ON CONFLICT DO NOTHING on the unique indexes.
    """
    attempted = len(records)
    if dry_run or attempted == 0:
        return {"attempted": attempted, "inserted": 0, "skipped": attempted}

    with conn.cursor() as cur:
        cur.executemany(_INSERT_SQL, records)
        inserted = cur.rowcount if cur.rowcount >= 0 else 0

    conn.commit()
    skipped = attempted - inserted
    return {"attempted": attempted, "inserted": inserted, "skipped": skipped}


def ingest_path(conn, path: Path, dry_run: bool = False, verbose: bool = False) -> dict:
    """Top-level entry. If path is a file, ingest that file. If path is a directory, ingest all *.json files.

    Returns dict with aggregate keys: files_processed, attempted, inserted, skipped.
    """
    totals = {"files_processed": 0, "attempted": 0, "inserted": 0, "skipped": 0}

    if path.is_file():
        sources: Iterator[tuple[Path, list[dict]]] = iter([(path, parse_json_file(path))])
    else:
        sources = records_from_directory(path)

    for file_path, records in sources:
        result = ingest_records(conn, records, dry_run=dry_run)
        totals["files_processed"] += 1
        totals["attempted"] += result["attempted"]
        totals["inserted"] += result["inserted"]
        totals["skipped"] += result["skipped"]

        if verbose:
            print(
                f"  {file_path.name}: "
                f"{result['attempted']} attempted, "
                f"{result['inserted']} inserted, "
                f"{result['skipped']} skipped"
            )

    return totals
