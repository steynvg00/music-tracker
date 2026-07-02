"""Badge detection + streaming-milestone notifications (v0.63).

v0.63 scope: play-milestone badges only — plays_50 / plays_100 / plays_200 /
plays_300 / plays_400 / plays_500. Detection piggy-backs on the 30-min
recently-played ingest cron: after each ingest, process_batch_milestones() is
called with the track_uris that appeared in this batch.

Mails are per-crossing (one dedicated email per threshold crossed), not digested.
v0.63 mails are text-only; the badge visual PNG (CID embed) arrives in v0.64 —
see the placeholder comment in _build_milestone_mail.
"""

from __future__ import annotations

import json
import sys
from html import escape
from typing import Literal

from lib.email_notify import _smtp_send

PLAY_MILESTONE_THRESHOLDS = [50, 100, 200, 300, 400, 500]

# v0.65: per-snapshot "#1 of this period" badges. One fixed badge_type per period
# cadence; the specific window (e.g. "January 2026") lives in context->>'window',
# so a track can hold many top_1st_month rows (one per month it topped).
TOP_1ST_BADGE_TYPES = [
    "top_1st_month",
    "top_1st_season",
    "top_1st_year",
    "top_1st_alltime",
    "top_1st_decade",
]

# Display labels for the Rankings strip, in render order. Kept parallel to the
# top_1st_* suffixes so both the mail and any future dashboard reuse one source.
_TOP_1ST_LABELS: list[tuple[str, str]] = [
    ("month", "🥇 Monthly #1"),
    ("season", "🥇 Seasonal #1"),
    ("year", "🥇 Yearly #1"),
    ("alltime", "🥇 All-time #1"),
    ("decade", "🥇 Decade #1"),
]


def detect_new_play_milestones(conn, batch_track_uris: list[str]) -> list[tuple[str, int]]:
    """Returns list of (track_uri, threshold) tuples for newly-crossed play milestones
    among the tracks that got new plays in this batch.

    Batch-scoped for safety: only checks tracks with plays in this batch, so if the
    backfill wasn't run first, worst-case blast radius is tracks the user is actively
    listening to right now, not all historical tracks.
    """
    if not batch_track_uris:
        return []

    with conn.cursor() as cur:
        cur.execute(
            """
            WITH batch_tracks AS (
              SELECT unnest(%s::text[]) AS track_uri
            ),
            totals AS (
              SELECT bt.track_uri, COUNT(sp.track_uri) AS plays
              FROM batch_tracks bt
              JOIN spotify_plays sp ON sp.track_uri = bt.track_uri
              WHERE sp.track_uri IS NOT NULL
              GROUP BY bt.track_uri
            ),
            thresholds AS (
              SELECT unnest(ARRAY[50, 100, 200, 300, 400, 500]) AS n
            ),
            should_award AS (
              SELECT t.track_uri, th.n
              FROM totals t
              CROSS JOIN thresholds th
              WHERE t.plays >= th.n
            )
            SELECT sa.track_uri, sa.n
            FROM should_award sa
            LEFT JOIN badge_events be
              ON be.entity_type = 'track'
              AND be.entity_id = sa.track_uri
              AND be.badge_type = 'plays_' || sa.n
            WHERE be.id IS NULL
            ORDER BY sa.track_uri, sa.n
            """,
            (batch_track_uris,),
        )
        return [(row[0], row[1]) for row in cur.fetchall()]


def _track_display(conn, track_uri: str) -> tuple[str, str, int, object]:
    """Returns (track_name, artist_display, total_plays, first_played_at) for a track.

    track_name/fallback-artist via DISTINCT ON (track_uri) FROM spotify_plays.
    artist_display prefers track_metadata.artist_names (joined), falls back to the
    spotify_plays credit string — same pattern as email_notify._hydrate_playcounts.
    track_metadata has NO track_name column (Lesson #18b), so name comes from plays.
    """
    cur = conn.cursor()

    cur.execute(
        """
        SELECT DISTINCT ON (track_uri) track_name, artist_name
        FROM spotify_plays
        WHERE track_uri = %s
        ORDER BY track_uri, played_at DESC
        """,
        (track_uri,),
    )
    row = cur.fetchone()
    track_name = (row[0] if row and row[0] else None) or "(unknown track)"
    fallback_artist = (row[1] if row and row[1] else None) or "(unknown artist)"

    cur.execute(
        """
        SELECT array_to_string(artist_names, ', ')
        FROM track_metadata
        WHERE track_uri = %s
          AND artist_names IS NOT NULL
          AND array_length(artist_names, 1) > 0
        """,
        (track_uri,),
    )
    meta_row = cur.fetchone()
    artist_display = (meta_row[0] if meta_row and meta_row[0] else None) or fallback_artist

    cur.execute(
        """
        SELECT COUNT(*), MIN(played_at)
        FROM spotify_plays
        WHERE track_uri = %s
        """,
        (track_uri,),
    )
    count_row = cur.fetchone()
    total_plays = count_row[0] if count_row else 0
    first_played_at = count_row[1] if count_row else None

    return track_name, artist_display, total_plays, first_played_at


# ── top_1st_* (Rankings) badges ─────────────────────────────────────────────────

def award_top_1st_badge(
    conn,
    track_uri: str,
    kind: Literal["month", "season", "year", "alltime", "decade"],
    context: dict,
    awarded_at=None,
) -> bool:
    """Insert a top_1st_{kind} badge_events row for this track.

    Returns True if inserted, False if it already existed for this specific window
    (UNIQUE conflict on entity_type, entity_id, badge_type, context->>'window').

    A track can win the same cadence for multiple windows (Jan 2026 + Feb 2026):
    both rows keep badge_type='top_1st_month' but carry distinct context['window'].
    Idempotency is per-window thanks to migration 0015's windowed unique index.

    awarded_at defaults to NOW(); the backfill passes the historical period-end date.
    """
    badge_type = f"top_1st_{kind}"
    with conn.cursor() as cur:
        if awarded_at is None:
            cur.execute(
                """
                INSERT INTO badge_events (entity_type, entity_id, badge_type, context)
                VALUES ('track', %s, %s, %s::jsonb)
                ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window'))
                    DO NOTHING
                RETURNING id
                """,
                (track_uri, badge_type, json.dumps(context)),
            )
        else:
            cur.execute(
                """
                INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
                VALUES ('track', %s, %s, %s, %s::jsonb)
                ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window'))
                    DO NOTHING
                RETURNING id
                """,
                (track_uri, badge_type, awarded_at, json.dumps(context)),
            )
        inserted = cur.fetchone() is not None
    conn.commit()
    return inserted


def _fetch_track_rankings(conn, track_uri: str) -> dict[str, list[str]]:
    """Returns {kind: [window, ...]} for every top_1st_* badge this track holds.

    Keys are the short kinds (month/season/year/alltime/decade); windows are ordered
    by awarded_at ascending. Kinds with no awards map to an empty list.
    """
    rankings: dict[str, list[str]] = {kind: [] for kind, _label in _TOP_1ST_LABELS}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT badge_type, context->>'window' AS window
            FROM badge_events
            WHERE entity_type = 'track'
              AND entity_id = %s
              AND badge_type LIKE 'top_1st_%%'
            ORDER BY awarded_at ASC
            """,
            (track_uri,),
        )
        for badge_type, window in cur.fetchall():
            kind = badge_type.removeprefix("top_1st_")
            if kind in rankings and window:
                rankings[kind].append(window)
    return rankings


def _build_milestone_mail(conn, track_uri: str, threshold: int) -> tuple[str, str, str]:
    """Returns (subject, html_body, plaintext_body) for one milestone crossing."""
    track_name, artist_display, total_plays, first_played_at = _track_display(conn, track_uri)
    first_play_str = first_played_at.date().isoformat() if first_played_at is not None else "unknown"

    subject = f"music-tracker: '{track_name}' just hit {threshold}+ plays"

    # Which play milestones has THIS track already earned? Drives the progression strip.
    # NOTE: scoped to this exact track_uri, NOT canonical-aggregated across URI variants.
    # Milestone mails alert on a specific URI's play-count crossing; rolling badges up to a
    # canonical group is a larger design question deferred to v0.70 (Track lookup badge display).
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT badge_type FROM badge_events
            WHERE entity_type = 'track'
              AND entity_id = %s
              AND badge_type LIKE 'plays_%%'
            """,
            (track_uri,),
        )
        earned_badge_types = {row[0] for row in cur.fetchall()}

    earned_flags = [(n, f"plays_{n}" in earned_badge_types) for n in PLAY_MILESTONE_THRESHOLDS]
    earned_count = sum(1 for _n, ok in earned_flags if ok)
    total_milestones = len(PLAY_MILESTONE_THRESHOLDS)
    if earned_count == total_milestones:
        # At 6/6 the celebration string stands alone — no "Play milestones — " prefix,
        # to avoid the redundant "milestones ... milestones" reading.
        progress_line = f"All {total_milestones} milestones reached! 🏆"
        strip_label = progress_line
    else:
        progress_line = f"{earned_count} of {total_milestones} reached"
        strip_label = f"Play milestones — {progress_line}"

    # v0.64 will replace the ✓/— text placeholders with badge PNG icons via CID embed.
    # The layout structure (6-cell horizontal strip, earned vs not-earned styling) stays;
    # only the inner cell content swaps from text to <img src="cid:badge_plays_50"> etc.
    strip_cells = []
    for n, ok in earned_flags:
        if ok:
            strip_cells.append(
                '<td style="padding:6px 10px;background:#1a5f1a;color:#fff;border-radius:4px;'
                'text-align:center;min-width:44px;">'
                f'<div style="font-weight:bold;">{n}</div>'
                '<div style="font-size:11px;opacity:0.85;">✓</div></td>'
            )
        else:
            strip_cells.append(
                '<td style="padding:6px 10px;background:#333;color:#888;border-radius:4px;'
                'text-align:center;min-width:44px;">'
                f'<div style="font-weight:bold;">{n}</div>'
                '<div style="font-size:11px;opacity:0.7;">—</div></td>'
            )
    strip_html = (
        '<div style="margin:16px 0;">'
        f'<p style="font-size:13px;color:#888;margin:0 0 6px 0;">{escape(strip_label)}</p>'
        '<table style="border-collapse:separate;border-spacing:6px 0;font-size:13px;"><tr>'
        + "".join(strip_cells)
        + "</tr></table></div>"
    )

    # Rankings strip (v0.65) — the "Pokémon badge doos": every top_1st_* category this
    # track has ever won, one row per cadence. Rows always present; a category with no
    # win shows an em-dash. If the track has no rankings at all, show a compact line.
    rankings = _fetch_track_rankings(conn, track_uri)
    any_ranking = any(rankings[kind] for kind, _label in _TOP_1ST_LABELS)
    if any_ranking:
        ranking_rows = []
        for kind, label in _TOP_1ST_LABELS:
            windows = rankings[kind]
            if windows:
                value_cell = f'<td style="padding:4px 0;">{escape(", ".join(windows))}</td>'
            else:
                value_cell = '<td style="padding:4px 0;color:#555;">—</td>'
            ranking_rows.append(
                f'<tr><td style="padding:4px 12px 4px 0;color:#888;min-width:100px;">{escape(label)}</td>'
                f'{value_cell}</tr>'
            )
        rankings_html = (
            '<div style="margin:16px 0;">'
            '<p style="font-size:13px;color:#888;margin:0 0 6px 0;">Rankings</p>'
            '<table style="font-size:13px;color:#ccc;">'
            + "".join(ranking_rows)
            + "</table></div>"
        )
    else:
        rankings_html = '<p style="font-size:13px;color:#888;margin:16px 0;">Rankings — none yet 🎯</p>'

    html_body = "\n".join([
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:640px;\">",
        f'<h2 style="margin:0 0 6px 0;">🏆 {threshold}+ plays milestone</h2>',
        # v0.64 badge PNG CID embed goes here.
        f'<p style="font-size:16px;margin:8px 0;"><strong>{escape(track_name)}</strong></p>',
        f'<p style="font-size:14px;color:#555;margin:2px 0;">{escape(artist_display)}</p>',
        '<table style="border-collapse:collapse;font-size:13px;margin:12px 0;">'
        f'<tr><td style="padding:2px 10px 2px 0;color:#888;">Total plays</td>'
        f'<td style="padding:2px 0;"><strong>{total_plays}</strong></td></tr>'
        f'<tr><td style="padding:2px 10px 2px 0;color:#888;">Milestone</td>'
        f'<td style="padding:2px 0;">{threshold}+ plays</td></tr>'
        f'<tr><td style="padding:2px 10px 2px 0;color:#888;">First played</td>'
        f'<td style="padding:2px 0;">{escape(first_play_str)}</td></tr>'
        "</table>",
        strip_html,
        rankings_html,
        "</body></html>",
    ])

    strip_plain_cells = "  ".join(
        f"[{n} {'✓' if ok else '—'}]" for n, ok in earned_flags
    )

    if any_ranking:
        label_width = max(len(label) for _kind, label in _TOP_1ST_LABELS) + 1  # + colon
        ranking_lines = ["Rankings:"]
        for kind, label in _TOP_1ST_LABELS:
            windows = rankings[kind]
            value = ", ".join(windows) if windows else "—"
            ranking_lines.append(f"  {(label + ':').ljust(label_width)} {value}")
        rankings_plain = "\n".join(ranking_lines)
    else:
        rankings_plain = "Rankings — none yet 🎯"

    plaintext_body = "\n".join([
        f"{threshold}+ plays milestone!",
        "",
        f"Track:       {track_name}",
        f"Artist(s):   {artist_display}",
        f"Total plays: {total_plays}",
        f"Milestone:   {threshold}+ plays",
        f"First played: {first_play_str}",
        "",
        f"{strip_label}:",
        f"  {strip_plain_cells}",
        "",
        rankings_plain,
    ])

    return subject, html_body, plaintext_body


def record_and_notify_milestone(conn, track_uri: str, threshold: int) -> bool:
    """Insert a badge_events row (awarded_at=NOW()) and send the milestone mail.

    Returns True if the row was inserted AND the mail was sent, False otherwise:
      - row already existed (UNIQUE conflict — another process beat us to it): no mail.
      - row inserted but mail send failed: warning logged, row kept (badge WAS earned),
        return False so it isn't counted as a sent mail. Same non-fatal pattern as
        v0.62's send_digest — a mail failure never breaks the caller.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO badge_events (entity_type, entity_id, badge_type, awarded_at, context)
            VALUES ('track', %s, %s, NOW(), '{"source": "live"}'::jsonb)
            ON CONFLICT (entity_type, entity_id, badge_type, (context->>'window')) DO NOTHING
            RETURNING id
            """,
            (track_uri, f"plays_{threshold}"),
        )
        inserted = cur.fetchone() is not None
    conn.commit()

    if not inserted:
        # Already awarded (backfill or concurrent process) — harmless, skip mail.
        return False

    try:
        subject, html_body, plaintext_body = _build_milestone_mail(conn, track_uri, threshold)
        return _smtp_send(subject, html_body, plaintext_body)
    except Exception as e:
        print(
            f"WARNING: badge {track_uri} plays_{threshold} recorded but mail failed: {e}",
            file=sys.stderr,
        )
        return False


def process_batch_milestones(conn, batch_track_uris: list[str]) -> int:
    """Orchestrator called from the ingest script. Returns count of mails sent.

    No-op (no queries, no logging noise) when detection finds nothing.
    """
    crossings = detect_new_play_milestones(conn, batch_track_uris)
    if not crossings:
        return 0

    sent = 0
    for track_uri, threshold in crossings:
        if record_and_notify_milestone(conn, track_uri, threshold):
            sent += 1
    return sent
