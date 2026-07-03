"""Email notification infrastructure for music-tracker (v0.62).

Foundation for all outbound mail. Provider is Gmail SMTP via an app password,
using stdlib ``smtplib`` only — no third-party email dependencies.

Two run types are supported:
  - ``weekly``: playlist refresh digest (created / updated / snapshots).
  - ``sweep``:  daily custom-playlist auto-deletion notice.

Local testing without a Gmail app password: set ``MUSIC_TRACKER_EMAIL_DRY_RUN=1``
and the HTML body is printed to stdout instead of being sent over SMTP.
"""

from __future__ import annotations

import os
import smtplib
from dataclasses import dataclass, field
from datetime import date
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from enum import Enum
from html import escape
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


# ── Kind badges ────────────────────────────────────────────────────────────────

_KIND_BADGE = {
    "updating": "🔄 updating",
    "snapshot": "📸 snapshot",
    "custom": "🎧 custom",
}


def _badge(kind: str) -> str:
    return _KIND_BADGE.get(kind, kind)


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


def _collect_hydration_uris(aggregates, deleted) -> list[str]:
    """Every track_uri that any section renders with a track name/artist."""
    uris: list[str] = []
    for agg in aggregates:
        if agg.is_top:
            uris.extend(t["uri"] for t in agg.ranked)
        else:
            uris.extend(agg.added)
            uris.extend(agg.removed)
    return uris


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


def _arrow_for(current_rank: int, previous_rank: int | None) -> tuple[str, str, str]:
    """Returns (label, html_color, plaintext_token) for a rank change."""
    if previous_rank is None:
        return ("★ NEW", "#dc4", "[★NEW]")
    if current_rank < previous_rank:
        delta = previous_rank - current_rank
        return (f"↑ {delta}", "#4a5", f"[↑ {delta}]")
    if current_rank > previous_rank:
        delta = current_rank - previous_rank
        return (f"↓ {delta}", "#c55", f"[↓ {delta}]")
    return ("—", "#666", "[—]")


# ── HTML builder ─────────────────────────────────────────────────────────────────

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


def _html_track_table(uris: list[str], playcounts, show_plays: bool) -> str:
    """Render an ordered (ranked) track table."""
    rows = []
    for rank, uri in enumerate(uris, start=1):
        name, artist, plays = playcounts.get(uri, ("(unknown track)", "(unknown artist)", 0))
        cells = (
            f'<td style="padding:2px 8px;color:#888;text-align:right;">{rank}</td>'
            f'<td style="padding:2px 8px;">{escape(name)}</td>'
            f'<td style="padding:2px 8px;color:#555;">{escape(artist)}</td>'
        )
        if show_plays:
            cells += f'<td style="padding:2px 8px;color:#888;text-align:right;">{plays} plays</td>'
        rows.append(f"<tr>{cells}</tr>")
    return (
        '<table style="border-collapse:collapse;font-size:13px;margin:6px 0 14px 0;">'
        + "".join(rows)
        + "</table>"
    )


def _html_ranked_table(ranked: list[dict], playcounts, prev_ranks: dict[str, int] | None) -> str:
    """Top-playlist table: rank [+ arrow] + track + artist + scope-correct plays.

    Uses each track's plays_in_context (NOT all-time). The arrow column only appears
    when prev_ranks is available (i.e. there is a previous weekly snapshot to diff).
    """
    show_arrows = prev_ranks is not None
    rows = []
    for t in ranked:
        rank = t["rank"]
        uri = t["uri"]
        plays = t.get("plays_in_context")
        name, artist = playcounts.get(uri, ("(unknown track)", "(unknown artist)", 0))[:2]
        cells = f'<td style="padding:2px 8px 2px 0;color:#888;text-align:right;">{rank}</td>'
        if show_arrows:
            label, color, _ = _arrow_for(rank, prev_ranks.get(uri))
            cells += (
                f'<td style="padding:2px 12px 2px 0;text-align:left;font-size:12px;">'
                f'<span style="color:{color};">{label}</span></td>'
            )
        cells += (
            f'<td style="padding:2px 8px;">{escape(name)}</td>'
            f'<td style="padding:2px 8px;color:#555;">{escape(artist)}</td>'
        )
        if plays is None:
            cells += (
                '<td style="padding:2px 8px;color:#888;text-align:right;">—</td>'
                '<!-- plays_in_context not available for this playlist type -->'
            )
        else:
            cells += f'<td style="padding:2px 8px;color:#888;text-align:right;">{plays} plays</td>'
        rows.append(f"<tr>{cells}</tr>")
    return (
        '<table style="border-collapse:collapse;font-size:13px;margin:6px 0 14px 0;">'
        + "".join(rows)
        + "</table>"
    )


def build_html_digest(events: list[PlaylistEvent], run_type: Literal["weekly", "sweep"], conn) -> str:
    aggregates, deleted = _aggregate(events)
    playcounts = _hydrate_playcounts(conn, _collect_hydration_uris(aggregates, deleted))

    created = [a for a in aggregates if a.created and a.kind != "snapshot"]
    snapshots = [a for a in aggregates if a.created and a.kind == "snapshot"]
    updated = [a for a in aggregates if not a.created and (a.added or a.removed)]

    summary = _summary_line(len(created), len(updated), len(snapshots), len(deleted), run_type)

    out: list[str] = [
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:720px;\">",
        f'<p style="font-size:15px;font-weight:600;">{escape(summary)}</p>',
    ]

    def playlist_heading(agg: _PlaylistAgg) -> str:
        return (
            f'<h3 style="margin:14px 0 2px 0;font-size:15px;">{escape(agg.name)} '
            f'<span style="font-size:12px;font-weight:normal;color:#888;">{escape(_badge(agg.kind))}</span></h3>'
        )

    # ── Section: New playlists ──────────────────────────────────────────────
    if created:
        out.append('<h2 style="border-bottom:1px solid #eee;padding-bottom:4px;">New playlists</h2>')
        for agg in created:
            out.append(playlist_heading(agg))
            if agg.description:
                out.append(f'<p style="margin:2px 0;color:#555;font-size:13px;">{escape(agg.description)}</p>')
            if agg.is_top and agg.ranked:
                out.append(_html_ranked_table(agg.ranked, playcounts, _fetch_previous_ranks(conn, agg.playlist_id)))
            else:
                out.append(
                    f'<p style="margin:2px 0;font-size:13px;">{len(agg.added)} tracks toegevoegd bij creatie.</p>'
                )

    # ── Section: Updated playlists ──────────────────────────────────────────
    if updated:
        out.append('<h2 style="border-bottom:1px solid #eee;padding-bottom:4px;">Updated playlists</h2>')
        for agg in updated:
            out.append(playlist_heading(agg))
            if agg.is_top:
                # Always the full ranked list, regardless of change count.
                out.append(
                    f'<p style="margin:2px 0;font-size:13px;color:#555;">'
                    f'+{len(agg.added)} tracks now in playlist</p>'
                )
                out.append(_html_ranked_table(agg.ranked, playcounts, _fetch_previous_ranks(conn, agg.playlist_id)))
            else:
                out.append(
                    f'<p style="margin:2px 0;font-size:13px;color:#555;">'
                    f'+{len(agg.added)} added, −{len(agg.removed)} removed</p>'
                )
                if agg.added:
                    out.append('<p style="margin:2px 0;font-size:13px;font-weight:600;">Added</p>')
                    out.append(_html_track_table(agg.added, playcounts, show_plays=False))
                if agg.removed:
                    out.append('<p style="margin:2px 0;font-size:13px;font-weight:600;">Removed</p>')
                    out.append(_html_track_table(agg.removed, playcounts, show_plays=False))

    # ── Section: Snapshots created ──────────────────────────────────────────
    if snapshots:
        out.append('<h2 style="border-bottom:1px solid #eee;padding-bottom:4px;">Snapshots created</h2>')
        for agg in snapshots:
            out.append(playlist_heading(agg))
            if agg.description:
                out.append(f'<p style="margin:2px 0;color:#555;font-size:13px;">{escape(agg.description)}</p>')
            if agg.ranked:
                out.append(_html_ranked_table(agg.ranked, playcounts, _fetch_previous_ranks(conn, agg.playlist_id)))

    # ── Section: Custom playlists deleted ───────────────────────────────────
    if run_type == "sweep" and deleted:
        out.append('<h2 style="border-bottom:1px solid #eee;padding-bottom:4px;">Custom playlists deleted</h2>')
        out.append('<ul style="font-size:13px;">')
        for e in deleted:
            expires_at = e.extra.get("expires_at", "")
            track_count = e.extra.get("track_count")
            detail = f"expired {escape(str(expires_at))}" if expires_at else "expired"
            if track_count is not None:
                detail += f", {track_count} tracks"
            out.append(f'<li>{escape(e.playlist_name)} — {detail}</li>')
        out.append("</ul>")

    out.append("</body></html>")
    return "\n".join(out)


# ── Plaintext builder ─────────────────────────────────────────────────────────────

def _text_track_lines(uris: list[str], playcounts, show_plays: bool) -> list[str]:
    lines = []
    for rank, uri in enumerate(uris, start=1):
        name, artist, plays = playcounts.get(uri, ("(unknown track)", "(unknown artist)", 0))
        line = f"  {rank}. {name} — {artist}"
        if show_plays:
            line += f" ({plays} plays)"
        lines.append(line)
    return lines


def _text_ranked_lines(ranked: list[dict], playcounts, prev_ranks: dict[str, int] | None) -> list[str]:
    """Top-playlist plaintext lines with scope-correct plays + optional rank arrows."""
    show_arrows = prev_ranks is not None
    lines = []
    for t in ranked:
        rank = t["rank"]
        uri = t["uri"]
        plays = t.get("plays_in_context")
        name, artist = playcounts.get(uri, ("(unknown track)", "(unknown artist)", 0))[:2]
        prefix = ""
        if show_arrows:
            _, _, token = _arrow_for(rank, prev_ranks.get(uri))
            prefix = f"{token} "
        plays_str = "—" if plays is None else f"{plays} plays"
        lines.append(f"  {prefix}{rank}. {name} — {artist} ({plays_str})")
    return lines


def build_plaintext_digest(events: list[PlaylistEvent], run_type: Literal["weekly", "sweep"], conn) -> str:
    aggregates, deleted = _aggregate(events)
    playcounts = _hydrate_playcounts(conn, _collect_hydration_uris(aggregates, deleted))

    created = [a for a in aggregates if a.created and a.kind != "snapshot"]
    snapshots = [a for a in aggregates if a.created and a.kind == "snapshot"]
    updated = [a for a in aggregates if not a.created and (a.added or a.removed)]

    lines: list[str] = [_summary_line(len(created), len(updated), len(snapshots), len(deleted), run_type), ""]

    if created:
        lines.append("NEW PLAYLISTS")
        for agg in created:
            lines.append(f"- {agg.name} [{_badge(agg.kind)}]")
            if agg.description:
                lines.append(f"  {agg.description}")
            if agg.is_top and agg.ranked:
                lines.extend(_text_ranked_lines(agg.ranked, playcounts, _fetch_previous_ranks(conn, agg.playlist_id)))
            else:
                lines.append(f"  {len(agg.added)} tracks toegevoegd bij creatie.")
        lines.append("")

    if updated:
        lines.append("UPDATED PLAYLISTS")
        for agg in updated:
            lines.append(f"- {agg.name} [{_badge(agg.kind)}]")
            if agg.is_top:
                lines.append(f"  +{len(agg.added)} tracks now in playlist")
                lines.extend(_text_ranked_lines(agg.ranked, playcounts, _fetch_previous_ranks(conn, agg.playlist_id)))
            else:
                lines.append(f"  +{len(agg.added)} added, -{len(agg.removed)} removed")
                if agg.added:
                    lines.append("  Added:")
                    lines.extend(_text_track_lines(agg.added, playcounts, show_plays=False))
                if agg.removed:
                    lines.append("  Removed:")
                    lines.extend(_text_track_lines(agg.removed, playcounts, show_plays=False))
        lines.append("")

    if snapshots:
        lines.append("SNAPSHOTS CREATED")
        for agg in snapshots:
            lines.append(f"- {agg.name} [{_badge(agg.kind)}]")
            if agg.description:
                lines.append(f"  {agg.description}")
            if agg.ranked:
                lines.extend(_text_ranked_lines(agg.ranked, playcounts, _fetch_previous_ranks(conn, agg.playlist_id)))
        lines.append("")

    if run_type == "sweep" and deleted:
        lines.append("CUSTOM PLAYLISTS DELETED")
        for e in deleted:
            expires_at = e.extra.get("expires_at", "")
            track_count = e.extra.get("track_count")
            detail = f"expired {expires_at}" if expires_at else "expired"
            if track_count is not None:
                detail += f", {track_count} tracks"
            lines.append(f"- {e.playlist_name} — {detail}")
        lines.append("")

    return "\n".join(lines)


# ── Markdown builder (Obsidian attachment) ──────────────────────────────────────

def _wikilink(text: str) -> str:
    """Wrap text in an Obsidian [[wikilink]], stripping chars illegal inside links."""
    cleaned = (
        text.replace("[", "(").replace("]", ")")
        .replace("|", "-").replace("#", "").replace("^", "")
    ).strip()
    return f"[[{cleaned}]]"


def _artist_wikilinks(artist_display: str) -> str:
    """Multi-artist 'A, B' -> '[[A]], [[B]]'."""
    parts = [a.strip() for a in artist_display.split(",") if a.strip()]
    return ", ".join(_wikilink(a) for a in parts) if parts else _wikilink(artist_display)


def build_markdown_digest(events: list[PlaylistEvent], run_type: Literal["weekly", "sweep"], conn) -> str:
    """Build a Markdown version of the digest for Obsidian vault use.

    YAML frontmatter (date, tags, week_number) + h1 + h2 per section, with track
    lists as numbered lists using [[wikilinks]] for track and artist names. Top
    playlists use scope-correct plays_in_context (same source as the HTML/plaintext).
    """
    aggregates, deleted = _aggregate(events)
    playcounts = _hydrate_playcounts(conn, _collect_hydration_uris(aggregates, deleted))

    created = [a for a in aggregates if a.created and a.kind != "snapshot"]
    snapshots = [a for a in aggregates if a.created and a.kind == "snapshot"]
    updated = [a for a in aggregates if not a.created and (a.added or a.removed)]

    today = date.today()
    week_number = today.isocalendar()[1]

    lines: list[str] = [
        "---",
        f"date: {today.isoformat()}",
        "tags: [music-tracker, weekly-digest]",
        f"week_number: {week_number}",
        "---",
        "",
        f"# Weekly digest — {today.isoformat()}",
        "",
        _summary_line(len(created), len(updated), len(snapshots), len(deleted), run_type),
        "",
    ]

    def ranked_md(agg: _PlaylistAgg) -> list[str]:
        out = []
        for t in agg.ranked:
            name, artist = playcounts.get(t["uri"], ("(unknown track)", "(unknown artist)", 0))[:2]
            plays = t.get("plays_in_context")
            plays_str = "—" if plays is None else f"{plays} plays"
            out.append(f"{t['rank']}. {_wikilink(name)} — {_artist_wikilinks(artist)} ({plays_str})")
        return out

    def uri_list_md(uris: list[str]) -> list[str]:
        out = []
        for i, uri in enumerate(uris, start=1):
            name, artist = playcounts.get(uri, ("(unknown track)", "(unknown artist)", 0))[:2]
            out.append(f"{i}. {_wikilink(name)} — {_artist_wikilinks(artist)}")
        return out

    if created:
        lines.append("## New playlists")
        lines.append("")
        for agg in created:
            lines.append(f"### {agg.name} ({_badge(agg.kind)})")
            if agg.description:
                lines.append(agg.description)
            if agg.is_top and agg.ranked:
                lines.extend(ranked_md(agg))
            else:
                lines.append(f"- {len(agg.added)} tracks added on creation")
            lines.append("")

    if updated:
        lines.append("## Updated playlists")
        lines.append("")
        for agg in updated:
            lines.append(f"### {agg.name} ({_badge(agg.kind)})")
            if agg.is_top:
                lines.append(f"- +{len(agg.added)} tracks now in playlist")
                lines.extend(ranked_md(agg))
            else:
                lines.append(f"- +{len(agg.added)} added, −{len(agg.removed)} removed")
                if agg.added:
                    lines.append("**Added**")
                    lines.extend(uri_list_md(agg.added))
                if agg.removed:
                    lines.append("**Removed**")
                    lines.extend(uri_list_md(agg.removed))
            lines.append("")

    if snapshots:
        lines.append("## Snapshots created")
        lines.append("")
        for agg in snapshots:
            lines.append(f"### {agg.name} ({_badge(agg.kind)})")
            if agg.description:
                lines.append(agg.description)
            if agg.ranked:
                lines.extend(ranked_md(agg))
            lines.append("")

    if run_type == "sweep" and deleted:
        lines.append("## Custom playlists deleted")
        lines.append("")
        for e in deleted:
            expires_at = e.extra.get("expires_at", "")
            track_count = e.extra.get("track_count")
            detail = f"expired {expires_at}" if expires_at else "expired"
            if track_count is not None:
                detail += f", {track_count} tracks"
            lines.append(f"- {e.playlist_name} — {detail}")
        lines.append("")

    return "\n".join(lines)


# ── Sender ─────────────────────────────────────────────────────────────────────

def _mail_secrets_or_raise() -> tuple[str, str, str]:
    """Read GMAIL_USER / GMAIL_APP_PASSWORD / EMAIL_RECIPIENT or raise a clear error."""
    gmail_user = os.environ.get("GMAIL_USER")
    gmail_password = os.environ.get("GMAIL_APP_PASSWORD")
    recipient = os.environ.get("EMAIL_RECIPIENT")
    missing = [
        name
        for name, val in (
            ("GMAIL_USER", gmail_user),
            ("GMAIL_APP_PASSWORD", gmail_password),
            ("EMAIL_RECIPIENT", recipient),
        )
        if not val
    ]
    if missing:
        raise RuntimeError(
            "Cannot send email — missing env vars: "
            + ", ".join(missing)
            + ". Set them as GitHub Actions secrets, or use MUSIC_TRACKER_EMAIL_DRY_RUN=1 for local testing."
        )
    return gmail_user, gmail_password, recipient


def _smtp_send(subject: str, html_body: str, plaintext_body: str) -> bool:
    """Low-level SMTP transport shared by all outbound mail (digests + milestones).

    - Reads GMAIL_USER / GMAIL_APP_PASSWORD / EMAIL_RECIPIENT from os.environ.
    - MUSIC_TRACKER_EMAIL_DRY_RUN=1: print subject + HTML body to stdout, no SMTP,
      return True (works without secrets, for local testing).
    - Raises RuntimeError with a clear message if any secret is missing.
    - Returns True on successful SMTP send.
    - Caller is responsible for catching exceptions to get non-fatal semantics.
    """
    if os.environ.get("MUSIC_TRACKER_EMAIL_DRY_RUN") == "1":
        print(f"[email] DRY RUN — subject={subject}", flush=True)
        print(html_body, flush=True)
        return True

    gmail_user, gmail_password, recipient = _mail_secrets_or_raise()

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = gmail_user
    msg["To"] = recipient
    msg.attach(MIMEText(plaintext_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(gmail_user, gmail_password)
        server.sendmail(gmail_user, [recipient], msg.as_string())

    print(f"Sent email to {recipient}: subject={subject}", flush=True)
    return True


def _smtp_send_with_attachment(
    subject: str,
    html_body: str,
    plaintext_body: str,
    attachment_content: str,
    attachment_filename: str,
) -> bool:
    """Same as _smtp_send but with a text attachment (Obsidian .md file).

    MIMEMultipart('mixed') = an 'alternative' plain/html part + a MIMEBase attachment
    with Content-Disposition: attachment. Honors MUSIC_TRACKER_EMAIL_DRY_RUN.
    """
    if os.environ.get("MUSIC_TRACKER_EMAIL_DRY_RUN") == "1":
        print(f"[email] DRY RUN — subject={subject}", flush=True)
        print(html_body, flush=True)
        print(f"[email] DRY RUN — attachment {attachment_filename}:", flush=True)
        print(attachment_content, flush=True)
        return True

    gmail_user, gmail_password, recipient = _mail_secrets_or_raise()

    outer = MIMEMultipart("mixed")
    outer["Subject"] = subject
    outer["From"] = gmail_user
    outer["To"] = recipient

    body = MIMEMultipart("alternative")
    body.attach(MIMEText(plaintext_body, "plain", "utf-8"))
    body.attach(MIMEText(html_body, "html", "utf-8"))
    outer.attach(body)

    part = MIMEBase("text", "markdown")
    part.set_payload(attachment_content.encode("utf-8"))
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", f'attachment; filename="{attachment_filename}"')
    outer.attach(part)

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(gmail_user, gmail_password)
        server.sendmail(gmail_user, [recipient], outer.as_string())

    print(f"Sent email to {recipient}: subject={subject} (+{attachment_filename})", flush=True)
    return True


def send_digest(collector: EmailEventCollector, conn, run_type: Literal["weekly", "sweep"]) -> bool:
    """Sends digest email. Returns True if sent (or dry-run printed), False if skipped.

    - Reads GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_RECIPIENT from os.environ.
      Raises RuntimeError met clear message als er events zijn maar secrets missing.
    - Skip send (return False) als collector geen events heeft.
    - Weekly digest attaches an Obsidian digest_YYYY-MM-DD.md; sweep mail has no attachment.
    - MUSIC_TRACKER_EMAIL_DRY_RUN=1: print HTML body to stdout, no SMTP, return True.
    """
    if not collector.has_events():
        return False

    events = collector.events
    html_body = build_html_digest(events, run_type, conn)
    text_body = build_plaintext_digest(events, run_type, conn)

    if run_type == "weekly":
        today = date.today().isoformat()
        subject = f"music-tracker: {len(events)} playlist updates ({today})"
        markdown_body = build_markdown_digest(events, run_type, conn)
        return _smtp_send_with_attachment(
            subject, html_body, text_body,
            attachment_content=markdown_body,
            attachment_filename=f"digest_{today}.md",
        )

    # sweep: no attachment
    n_deleted = sum(1 for e in events if e.event_type == EventType.CUSTOM_DELETED)
    subject = f"music-tracker: {n_deleted} custom playlists auto-deleted"
    return _smtp_send(subject, html_body, text_body)
