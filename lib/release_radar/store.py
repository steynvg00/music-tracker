"""Release radar (v0.87, R7): write source items into radar_releases, merged across sources.

Merge rule (lib/release_radar/match.py): an item belongs to an existing release when
  * the same source already reported it (radar_release_sources PK (source, external_id)), or
  * it is the same Spotify album, or
  * the normalised artist + normalised title are equal and the dates are within 14 days
    (or one side has no day-precise date yet).
Otherwise it's a new release. The more precise date wins; Spotify fields (album id, URL, track
URIs) come from the Spotify source; the label from whichever source names one.
"""
from __future__ import annotations

from lib.release_radar.match import better_date, dates_close, norm_title
from lib.release_radar.model import ReleaseItem


def _find(cur, it: ReleaseItem, title_key: str) -> int | None:
    cur.execute("SELECT release_id FROM radar_release_sources WHERE source = %s AND external_id = %s", (it.source, it.external_id))
    row = cur.fetchone()
    if row:
        return row[0]
    if it.spotify_album_id:
        cur.execute("SELECT id FROM radar_releases WHERE spotify_album_id = %s", (it.spotify_album_id,))
        row = cur.fetchone()
        if row:
            return row[0]
    cur.execute(
        "SELECT id, release_date, date_precision FROM radar_releases WHERE artist_key = %s AND title_key = %s ORDER BY id",
        (it.artist_key, title_key),
    )
    for rid, d, prec in cur.fetchall():
        exact_new = it.precision == "day"
        exact_old = prec == "day"
        if dates_close(d if exact_old else None, it.release_date if exact_new else None):
            return rid
    return None


def upsert(conn, items: list[ReleaseItem]) -> dict:
    cur = conn.cursor()
    created = merged = 0
    for it in items:
        if not it.title.strip():
            continue
        tkey = norm_title(it.title)
        if not tkey:
            continue
        rid = _find(cur, it, tkey)
        if rid is None:
            cur.execute(
                """INSERT INTO radar_releases (artist_key, artist_name, artist_id, title, title_key, release_date, date_precision,
                       release_type, label, spotify_album_id, spotify_url, track_uris)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                (it.artist_key, it.artist_name, it.artist_id, it.title, tkey, it.release_date, it.precision, it.release_type,
                 it.label, it.spotify_album_id, it.url if it.source == "spotify" else None, it.track_uris),
            )
            rid = cur.fetchone()[0]
            created += 1
        else:
            cur.execute("SELECT release_date, date_precision, title, artist_id FROM radar_releases WHERE id = %s", (rid,))
            d0, p0, title0, aid0 = cur.fetchone()
            d, p = better_date((d0, p0), (it.release_date, it.precision))
            is_sp = it.source == "spotify"
            cur.execute(
                """UPDATE radar_releases SET
                       release_date = %s, date_precision = %s,
                       title = CASE WHEN %s THEN %s ELSE title END,
                       artist_id = COALESCE(artist_id, %s),
                       release_type = COALESCE(release_type, %s),
                       label = COALESCE(label, %s),
                       spotify_album_id = COALESCE(spotify_album_id, %s),
                       spotify_url = CASE WHEN %s THEN %s ELSE spotify_url END,
                       track_uris = CASE WHEN %s AND cardinality(%s::text[]) > 0 THEN %s::text[] ELSE track_uris END,
                       updated_at = now()
                   WHERE id = %s""",
                (d, p, is_sp, it.title, it.artist_id, it.release_type, it.label, it.spotify_album_id,
                 is_sp, it.url, is_sp, it.track_uris, it.track_uris, rid),
            )
            merged += 1
        cur.execute(
            """INSERT INTO radar_release_sources (source, external_id, release_id, artist, title, label, release_date, url)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (source, external_id) DO UPDATE SET release_id = EXCLUDED.release_id, artist = EXCLUDED.artist,
                   title = EXCLUDED.title, label = EXCLUDED.label, release_date = EXCLUDED.release_date, url = EXCLUDED.url, seen_at = now()""",
            (it.source, it.external_id, rid, it.artist_name, it.title, it.label, it.release_date, it.url),
        )
    conn.commit()
    return {"created": created, "merged": merged}


def refresh_in_library(conn) -> int:
    """in_library = a track of the release was played or liked (Spotify album / track URIs), or —
    for releases not on Spotify yet — a played track with the same normalised title by that artist."""
    cur = conn.cursor()
    cur.execute(
        """UPDATE radar_releases r SET in_library = EXISTS (
               SELECT 1 FROM track_metadata tm JOIN spotify_plays sp ON sp.track_uri = tm.track_uri
               WHERE r.spotify_album_id IS NOT NULL AND tm.album_id = r.spotify_album_id
           ) OR EXISTS (
               SELECT 1 FROM spotify_plays sp WHERE sp.track_uri = ANY(r.track_uris)
           ) OR EXISTS (
               SELECT 1 FROM liked_songs ls WHERE ls.track_uri = ANY(r.track_uris)
           )"""
    )
    # Text match for the rest (label/MusicBrainz-only releases): Python-normalised titles of your plays.
    cur.execute("SELECT id, artist_key, title_key FROM radar_releases WHERE NOT in_library")
    pending = cur.fetchall()
    if pending:
        cur.execute("SELECT DISTINCT artist, track FROM hub.day_track")
        from lib.release_radar.match import credit_matches

        played: dict[str, list[str]] = {}
        for artist, track in cur.fetchall():
            played.setdefault(norm_title(track), []).append(artist)
        hits = [rid for rid, akey, tkey in pending if any(credit_matches(a, akey) for a in played.get(tkey, []))]
        if hits:
            cur.execute("UPDATE radar_releases SET in_library = true WHERE id = ANY(%s)", (hits,))
    cur.execute("SELECT count(*) FROM radar_releases WHERE in_library")
    n = cur.fetchone()[0]
    conn.commit()
    return n


def record_source(conn, source: str, *, ok: bool, today, items: int, error: str | None, detail: dict) -> dict:
    """Update radar_sources; returns {'streak_days', 'notify'} (notify once per failure streak ≥ 3 days)."""
    cur = conn.cursor()
    if ok:
        cur.execute(
            """UPDATE radar_sources SET last_run_at = now(), last_success_at = now(), consecutive_failures = 0,
                   failing_since = NULL, failure_notified_at = NULL, last_items = %s, detail = %s::jsonb
               WHERE source = %s""",
            (items, _json(detail), source),
        )
        conn.commit()
        return {"streak_days": 0, "notify": False}
    cur.execute(
        """UPDATE radar_sources SET last_run_at = now(), last_error = %s, last_error_at = now(),
               consecutive_failures = consecutive_failures + 1, failing_since = COALESCE(failing_since, %s), detail = %s::jsonb
           WHERE source = %s RETURNING failing_since, failure_notified_at""",
        ((error or "failed")[:500], today, _json(detail), source),
    )
    since, notified = cur.fetchone()
    conn.commit()
    days = (today - since).days + 1
    return {"streak_days": days, "notify": days >= 3 and notified is None, "failing_since": since}


def mark_notified(conn, source: str) -> None:
    cur = conn.cursor()
    cur.execute("UPDATE radar_sources SET failure_notified_at = now() WHERE source = %s", (source,))
    conn.commit()


def _json(d: dict) -> str:
    import json

    return json.dumps(d, default=str)
