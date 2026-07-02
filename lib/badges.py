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

import sys
from html import escape

from lib.email_notify import _smtp_send

PLAY_MILESTONE_THRESHOLDS = [50, 100, 200, 300, 400, 500]


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
        "</body></html>",
    ])

    strip_plain_cells = "  ".join(
        f"[{n} {'✓' if ok else '—'}]" for n, ok in earned_flags
    )
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
            ON CONFLICT (entity_type, entity_id, badge_type) DO NOTHING
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
