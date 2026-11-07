"""Playlist-change digests for music-tracker (v0.62; push-only since v0.89).

The crons collect what they changed (EmailEventCollector: created / updated / snapshots /
custom playlists deleted) and ``send_digest`` turns one run into one Web Push (lib/notify.py).
Until v0.88 this was a Gmail mail; Gmail/SMTP was removed in v0.89 (R9) after every mail failed
from 2026-10-21. The full digest is stored as data first (digest_runs, migration 0029) and read
in Rotor's "This week" page, which is where the push links to.

The module keeps its name (and EmailEventCollector its name) because the playlist code imports
them everywhere; nothing here sends mail any more.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class EventType(str, Enum):
    PLAYLIST_CREATED = "playlist_created"
    TRACKS_ADDED = "tracks_added"
    TRACKS_REMOVED = "tracks_removed"
    SNAPSHOT_CREATED = "snapshot_created"
    CUSTOM_DELETED = "custom_deleted"


@dataclass
class PlaylistEvent:
    event_type: EventType
    playlist_name: str
    playlist_kind: Literal["updating", "snapshot", "custom"]
    is_top_playlist: bool  # kind=='snapshot' OR suffix contains 'Top ' or 'Top-'
    tracks: list[str] = field(default_factory=list)  # non-Top: raw uris (diff or creation list)
    # v0.66: Top playlists carry per-track SCOPE-CORRECT counts here instead of `tracks`.
    # Each dict: {"uri": str, "rank": int, "plays_in_context": int | None}. plays_in_context
    # is None when the playlist's ranking window can't cheaply produce per-track counts —
    # rendered as "—" rather than a misleading all-time number.
    ranked_tracks: list[dict] = field(default_factory=list)
    playlist_id: str = ""  # Spotify id — needed to look up rank history for arrows
    extra: dict = field(default_factory=dict)  # e.g. {"description": "...", "expires_at": "..."}


@dataclass
class EmailEventCollector:
    events: list[PlaylistEvent] = field(default_factory=list)

    def add_event(self, event: PlaylistEvent) -> None:
        self.events.append(event)

    def has_events(self) -> bool:
        return bool(self.events)


def _is_top_playlist(playlist_name: str, playlist_kind: str) -> bool:
    """Top playlist detection helper — kept module-level so playlists.py can reuse it."""
    if playlist_kind == "snapshot":
        return True
    return "Top " in playlist_name or "Top-" in playlist_name


# ── Playcount hydration ─────────────────────────────────────────────────────────

def _hydrate_playcounts(conn, track_uris: list[str]) -> dict[str, tuple[str, str, int]]:
    """Returns dict: track_uri -> (track_name, artist_display, total_plays).

    track_name / artist bronnen: DISTINCT ON (track_uri) FROM spotify_plays
      ORDER BY track_uri, played_at DESC.
    artist_display: multi-artist joined via track_metadata.artist_names if available,
      else spotify_plays.artist_name fallback.
    total_plays: COUNT(*) FROM spotify_plays GROUP BY track_uri (all-time).
    """
    uris = list(dict.fromkeys(u for u in track_uris if u))  # unique, order-preserving
    if not uris:
        return {}

    cur = conn.cursor()

    # Latest track_name + fallback artist string per track_uri.
    cur.execute(
        """
        SELECT DISTINCT ON (track_uri) track_uri, track_name, artist_name
        FROM spotify_plays
        WHERE track_uri = ANY(%s)
        ORDER BY track_uri, played_at DESC
        """,
        (uris,),
    )
    names: dict[str, tuple[str, str]] = {}
    for track_uri, track_name, artist_name in cur.fetchall():
        names[track_uri] = (track_name or "(unknown track)", artist_name or "(unknown artist)")

    # All-time playcount per track_uri.
    cur.execute(
        """
        SELECT track_uri, COUNT(*)
        FROM spotify_plays
        WHERE track_uri = ANY(%s)
        GROUP BY track_uri
        """,
        (uris,),
    )
    plays: dict[str, int] = {row[0]: row[1] for row in cur.fetchall()}

    # Multi-artist display from track_metadata (preferred over the plays credit string).
    cur.execute(
        """
        SELECT track_uri, array_to_string(artist_names, ', ')
        FROM track_metadata
        WHERE track_uri = ANY(%s)
          AND artist_names IS NOT NULL
          AND array_length(artist_names, 1) > 0
        """,
        (uris,),
    )
    meta_artists: dict[str, str] = {row[0]: row[1] for row in cur.fetchall() if row[1]}

    result: dict[str, tuple[str, str, int]] = {}
    for uri in uris:
        track_name, fallback_artist = names.get(uri, ("(unknown track)", "(unknown artist)"))
        artist_display = meta_artists.get(uri) or fallback_artist
        result[uri] = (track_name, artist_display, plays.get(uri, 0))
    return result


# ── Event aggregation ────────────────────────────────────────────────────────────

@dataclass
class _PlaylistAgg:
    name: str
    kind: str
    is_top: bool
    created: bool = False
    description: str = ""
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    ranked: list[dict] = field(default_factory=list)  # Top playlists: scope-correct ranked tracks
    playlist_id: str = ""


def _aggregate(events: list[PlaylistEvent]):
    """Collapse the flat event list into per-playlist aggregates + custom deletions.

    Returns (aggregates_in_first_seen_order, custom_deleted_events).
    """
    aggs: dict[str, _PlaylistAgg] = {}
    order: list[str] = []
    deleted: list[PlaylistEvent] = []

    for e in events:
        if e.event_type == EventType.CUSTOM_DELETED:
            deleted.append(e)
            continue
        agg = aggs.get(e.playlist_name)
        if agg is None:
            agg = _PlaylistAgg(name=e.playlist_name, kind=e.playlist_kind, is_top=e.is_top_playlist)
            aggs[e.playlist_name] = agg
            order.append(e.playlist_name)
        if e.playlist_id:
            agg.playlist_id = e.playlist_id
        if e.event_type in (EventType.PLAYLIST_CREATED, EventType.SNAPSHOT_CREATED):
            agg.created = True
            desc = e.extra.get("description")
            if desc:
                agg.description = desc
        elif e.event_type == EventType.TRACKS_ADDED:
            if e.ranked_tracks:  # Top playlist: scope-correct ranked list
                agg.ranked = list(e.ranked_tracks)
                agg.added = [t["uri"] for t in e.ranked_tracks]
            else:
                agg.added = list(e.tracks)  # non-Top: diff list
        elif e.event_type == EventType.TRACKS_REMOVED:
            agg.removed = list(e.tracks)

    return [aggs[name] for name in order], deleted


# ── Rank change arrows (v0.66) ──────────────────────────────────────────────────

def _fetch_previous_ranks(conn, playlist_id: str) -> dict[str, int] | None:
    """Rank map {track_uri: rank} from the snapshot immediately BEFORE the latest one.

    Returns None if fewer than 2 snapshots exist for this playlist (first week after
    deploy → no baseline to diff against → no arrows). The current run's snapshot has
    already been written by the time the digest renders, so the 2nd-most-recent
    distinct snapshot_at is the correct "previous week" baseline.
    """
    if not playlist_id:
        return None
    cur = conn.cursor()
    cur.execute(
        """
        SELECT DISTINCT snapshot_at FROM playlist_rank_history
        WHERE playlist_id = %s
        ORDER BY snapshot_at DESC
        LIMIT 2
        """,
        (playlist_id,),
    )
    snaps = [row[0] for row in cur.fetchall()]
    if len(snaps) < 2:
        return None
    cur.execute(
        "SELECT track_uri, rank FROM playlist_rank_history WHERE playlist_id = %s AND snapshot_at = %s",
        (playlist_id, snaps[1]),
    )
    return {row[0]: row[1] for row in cur.fetchall()}


def _should_show_arrows(ranked: list[dict], prev_ranks: dict[str, int] | None) -> bool:
    """True only when there is a baseline AND at least one track's rank actually changed.

    v0.72: if every track is unchanged (all arrows would be '—'), suppress the arrow column
    entirely for this playlist. Without this, a monthly-cadence Top list (e.g. Top 100
    all-time/this-year after v0.72) would render 100 identical '—' rows in every weekly
    digest between its monthly refreshes. A track absent from prev_ranks (a new entry) reads
    as a change — prev_ranks.get(uri) is None, which never equals an int rank.
    """
    if prev_ranks is None:
        return False
    return any(prev_ranks.get(t["uri"]) != t["rank"] for t in ranked)


# ── Summary line ─────────────────────────────────────────────────────────────────

def _summary_line(created, updated, snapshots, deleted, run_type: str) -> str:
    parts = []
    if created:
        parts.append(f"{created} playlist{'s' if created != 1 else ''} created")
    if updated:
        parts.append(f"{updated} updated")
    if snapshots:
        parts.append(f"{snapshots} snapshot{'s' if snapshots != 1 else ''} created")
    if run_type == "sweep" and deleted:
        parts.append(f"{deleted} custom playlist{'s' if deleted != 1 else ''} deleted")
    if not parts:
        return "No changes."
    return ", ".join(parts) + "."


_RUN_TITLE = {"weekly": "Weekly refresh", "monthly": "Monthly refresh", "sweep": "Custom playlists deleted"}


def send_digest(
    collector: EmailEventCollector, conn, run_type: Literal["weekly", "monthly", "sweep"]
) -> bool:
    """Store the digest (digest_runs) and push it. Returns True if at least one device got it.

    - No events → nothing stored or sent, returns False.
    - Push type per run: weekly_digest / monthly_digest / custom_sweep (switchable in Settings).
    - Never raises for a push problem: the playlist work already happened (lib/notify.py).
    - digest_runs.delivery_status: push_sent | push_no_device | push_off.
    """
    if not collector.has_events():
        return False

    from lib import notify
    from lib.digest_store import mark_delivery, record_digest

    events = collector.events
    digest_id = record_digest(conn, events, run_type)
    aggregates, deleted = _aggregate(events)
    created = sum(1 for a in aggregates if a.created and a.kind != "snapshot")
    snapshots = sum(1 for a in aggregates if a.created and a.kind == "snapshot")
    updated = sum(1 for a in aggregates if not a.created and (a.added or a.removed))
    summary = _summary_line(created, updated, snapshots, len(deleted), run_type)
    if run_type == "sweep":
        names = ", ".join(e.playlist_name for e in deleted[:3]) + (f" and {len(deleted) - 3} more" if len(deleted) > 3 else "")
        kind, body, url = "custom_sweep", f"{notify.plural(len(deleted), 'expired custom playlist')}: {names}", "/library"
    else:
        kind, body, url = f"{run_type}_digest", summary, "/digest"
    n = notify.notify(conn, kind, title=_RUN_TITLE[run_type], body=body, url=url,
                      dedupe_key=f"digest:{digest_id}" if digest_id is not None else None, tag=f"digest-{run_type}")
    mark_delivery(conn, digest_id, "push_off" if n < 0 else "push_sent" if n > 0 else "push_no_device")
    return n > 0
