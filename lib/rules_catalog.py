"""Export the playlist rule catalog for the Rotor hub (v0.82, R2).

lib/playlists.describe_playlist_categories() is the single source of the 16 rule
categories (the same data the Streamlit "Playlist Rules" page renders). This module
copies it into playlist_rule_categories and tags each mirrored playlist with its
category (spotify_playlists.rule_category), so the hub's Rules view and "About this
playlist" need no Python at request time. DB only; no Spotify calls.

Runs after the nightly playlist mirror (scripts/sync_playlist_mirror.py) and in the
daily hub-jobs run.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict

from lib.playlists import (
    CAT_SNAPSHOT_DECADE,
    SNAPSHOT_NAME_SUFFIX,
    describe_playlist_categories,
    get_full_name,
    get_snapshot_definitions,
    get_updating_definitions,
)

# Decade snapshots have no definition builder (see CATEGORY_SPECS notes).
_DECADE_RE = re.compile(r"^Top 100 · \d{4}s" + re.escape(SNAPSHOT_NAME_SUFFIX) + "$")


def name_to_category(conn) -> dict[str, str]:
    """Full Spotify name (and legacy names) → category key, from the live registry."""
    out: dict[str, str] = {}
    for d in get_updating_definitions(conn) + get_snapshot_definitions(conn):
        if not d.category:
            continue
        out[get_full_name(d)] = d.category
        for legacy in d.legacy_names:
            out.setdefault(legacy, d.category)
    return out


def category_for(name: str, mapping: dict[str, str]) -> str | None:
    if name in mapping:
        return mapping[name]
    if _DECADE_RE.match(name):
        return CAT_SNAPSHOT_DECADE
    return None


_UPSERT = """
INSERT INTO playlist_rule_categories (
    key, position, name, kind, playlist_count, name_form, rule_nl, schedule_kind, schedule_nl,
    next_creation_nl, cron, cron_job, cron_script, member_variation, variants, example_names,
    notes, query_sources, exported_at
) VALUES (
    %(key)s, %(position)s, %(name)s, %(kind)s, %(playlist_count)s, %(name_form)s, %(rule_nl)s,
    %(schedule_kind)s, %(schedule_nl)s, %(next_creation_nl)s, %(cron)s, %(cron_job)s,
    %(cron_script)s, %(member_variation)s, %(variants)s::jsonb, %(example_names)s, %(notes)s,
    %(query_sources)s::jsonb, now()
)
ON CONFLICT (key) DO UPDATE SET
    position = EXCLUDED.position, name = EXCLUDED.name, kind = EXCLUDED.kind,
    playlist_count = EXCLUDED.playlist_count, name_form = EXCLUDED.name_form,
    rule_nl = EXCLUDED.rule_nl, schedule_kind = EXCLUDED.schedule_kind,
    schedule_nl = EXCLUDED.schedule_nl, next_creation_nl = EXCLUDED.next_creation_nl,
    cron = EXCLUDED.cron, cron_job = EXCLUDED.cron_job, cron_script = EXCLUDED.cron_script,
    member_variation = EXCLUDED.member_variation, variants = EXCLUDED.variants,
    example_names = EXCLUDED.example_names, notes = EXCLUDED.notes,
    query_sources = EXCLUDED.query_sources, exported_at = EXCLUDED.exported_at
"""


def export_rules_catalog(conn) -> dict:
    categories = describe_playlist_categories(conn)
    cur = conn.cursor()
    for position, c in enumerate(categories):
        row = asdict(c)
        row["position"] = position
        row["variants"] = json.dumps(row["variants"], ensure_ascii=False)
        row["query_sources"] = json.dumps(row["query_sources"], ensure_ascii=False)
        cur.execute(_UPSERT, row)
    keys = [c.key for c in categories]
    cur.execute("DELETE FROM playlist_rule_categories WHERE NOT (key = ANY(%s))", (keys,))

    mapping = name_to_category(conn)
    cur.execute(
        "SELECT playlist_id, name, rule_category FROM spotify_playlists WHERE removed_at IS NULL AND is_owned"
    )
    changes = []
    for playlist_id, name, current in cur.fetchall():
        cat = category_for(name, mapping)
        if cat != current:
            changes.append((cat, playlist_id))
    if changes:
        cur.executemany("UPDATE spotify_playlists SET rule_category = %s WHERE playlist_id = %s", changes)
    conn.commit()
    return {
        "categories": len(categories),
        "playlists_in_registry": sum(c.playlist_count for c in categories),
        "mirror_rows_changed": len(changes),
    }
