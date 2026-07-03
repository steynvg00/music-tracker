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
from datetime import date, datetime, time, timedelta
from html import escape
from typing import Literal
from zoneinfo import ZoneInfo

from lib.email_notify import _smtp_send

TZ_AMSTERDAM = ZoneInfo("Europe/Amsterdam")

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

# ── v0.67: special badges — the 10 remaining badge categories ────────────────────
# Multi-fire badges (plays_20_in_day / plays_40_in_day / comeback) carry a non-NULL
# context['window'] so the migration-0015 windowed unique index lets a track earn
# them repeatedly (once per day/month). Every other special badge is once-per-track
# lifetime with a NULL window.
STREAK_BADGE_TYPES = ["streak_5_years", "streak_10_years"]
DAILY_INTENSITY_BADGE_TYPES = ["plays_20_in_day", "plays_40_in_day"]
RELEASE_TIMING_BADGE_TYPES = ["played_on_release_day", "day_one_stan", "late_bloomer"]
BEHAVIORAL_BADGE_TYPES = ["comeback", "season_regular", "multi_top"]

SPECIAL_BADGE_TYPES = (
    STREAK_BADGE_TYPES
    + DAILY_INTENSITY_BADGE_TYPES
    + RELEASE_TIMING_BADGE_TYPES
    + BEHAVIORAL_BADGE_TYPES
)

# Special strip layout — 4 category rows, each a (emoji-label, [(badge_type, slot_label)]).
# Kept parallel to the *_BADGE_TYPES lists so the strip and detection share one order.
_SPECIAL_STRIP: list[tuple[str, list[tuple[str, str]]]] = [
    ("🔥 Streaks", [("streak_5_years", "5-year"), ("streak_10_years", "10-year")]),
    ("⚡ Daily intensity", [("plays_20_in_day", "20 in a day"), ("plays_40_in_day", "40 in a day")]),
    ("🎬 Release timing", [
        ("played_on_release_day", "Played on release day"),
        ("day_one_stan", "Day-one stan"),
        ("late_bloomer", "Late bloomer"),
    ]),
    ("🎭 Behavioral", [
        ("comeback", "Comeback"),
        ("season_regular", "Season regular"),
        ("multi_top", "Multi-top"),
    ]),
]

# Category emoji per badge_type, used by the per-badge mail header.
_SPECIAL_BADGE_EMOJI: dict[str, str] = {
    bt: emoji.split()[0]
    for emoji, slots in _SPECIAL_STRIP
    for bt, _label in slots
}


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

    # Special badges strip (v0.67) — the third "Pokémon doos": all 10 special badge
    # types in 4 category rows, earned vs not-earned. Same scoping caveat as the
    # rankings strip (this exact track_uri, not canonical-aggregated).
    special_html, special_plain = _build_special_strip(conn, track_uri)

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
        special_html,
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
        "",
        special_plain,
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
        mail_sent = _smtp_send(subject, html_body, plaintext_body)
    except Exception as e:
        print(
            f"WARNING: badge {track_uri} plays_{threshold} recorded but mail failed: {e}",
            file=sys.stderr,
        )
        mail_sent = False

    # v0.67: crossing plays_50 is the trigger point for the release-timing achievement
    # badges (day_one_stan / late_bloomer). Non-fatal: a failure here must not undo the
    # play-milestone result. Each is once-per-track; the windowed index dedupes re-runs.
    if threshold == 50:
        try:
            outcome = detect_release_timing_at_50_plays(conn, track_uri)
            if outcome is not None:
                badge_type_earned, ctx = outcome
                award_special_badge(conn, track_uri, badge_type_earned, ctx, send_mail=True)
        except Exception as e:
            print(
                f"WARNING: release-timing badge check for {track_uri} failed: {e}",
                file=sys.stderr,
            )

    return mail_sent


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


# ══════════════════════════════════════════════════════════════════════════════════
# v0.67 — Special badges (10 types) + generic award/notify + detection helpers
# ══════════════════════════════════════════════════════════════════════════════════
#
# Detection functions share a two-mode contract:
#   - batch mode  (batch_track_uris=[...]): scope to just those tracks — cheap, called
#     from the live crons so a failure's blast radius is what the user played *now*.
#   - full mode   (batch_track_uris=None):  scope to every track — used by the backfill.
# Each returns list[tuple[track_uri, badge_type, context]]. A context MAY carry an
# 'awarded_at' ISO key; award_special_badge lifts it onto the awarded_at column (and
# strips it from the stored JSONB) so backfill rows get their true historical crossing
# time. Multi-fire badges additionally carry context['window'] for the unique index.


def _has_badge(conn, track_uri: str, badge_type: str, window: str | None = None) -> bool:
    """True if this (track, badge_type, window) already exists — window matched by
    context->>'window' (NULL for once-per-track lifetime badges)."""
    with conn.cursor() as cur:
        if window is None:
            cur.execute(
                """
                SELECT 1 FROM badge_events
                WHERE entity_type = 'track' AND entity_id = %s AND badge_type = %s
                  AND context->>'window' IS NULL
                LIMIT 1
                """,
                (track_uri, badge_type),
            )
        else:
            cur.execute(
                """
                SELECT 1 FROM badge_events
                WHERE entity_type = 'track' AND entity_id = %s AND badge_type = %s
                  AND context->>'window' = %s
                LIMIT 1
                """,
                (track_uri, badge_type, window),
            )
        return cur.fetchone() is not None


def _first_play_in_year(conn, track_uri: str, year: int):
    """MIN(played_at) for a track within a local calendar year (streak awarded_at)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT MIN(played_at) FROM spotify_plays
            WHERE track_uri = %s
              AND EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int = %s
            """,
            (track_uri, year),
        )
        row = cur.fetchone()
        return row[0] if row else None


def _end_of_day_iso(d: date) -> str:
    return datetime.combine(d, time(23, 59, 59), TZ_AMSTERDAM).isoformat()


def _end_of_month_iso(month_start: date) -> str:
    nxt = date(month_start.year + 1, 1, 1) if month_start.month == 12 \
        else date(month_start.year, month_start.month + 1, 1)
    return _end_of_day_iso(nxt - timedelta(days=1))


def _play_date_span(conn) -> tuple[date, date] | None:
    """(earliest, latest) local play date across all tracks, or None if empty."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT MIN(played_at), MAX(played_at) FROM spotify_plays WHERE track_uri IS NOT NULL"
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return None
    return (row[0].astimezone(TZ_AMSTERDAM).date(), row[1].astimezone(TZ_AMSTERDAM).date())


def award_special_badge(
    conn,
    track_uri: str,
    badge_type: str,
    context: dict,
    send_mail: bool = True,
) -> bool:
    """Insert a special-badge row (ON CONFLICT DO NOTHING on the windowed unique index)
    and optionally send its mail.

    Returns True if the row was newly inserted and (mailed OR send_mail=False); False on
    a UNIQUE conflict (already awarded) or a post-insert mail failure (row is kept — the
    badge WAS earned — and a warning is logged, same non-fatal pattern as v0.63).

    context may include an 'awarded_at' ISO string: it's lifted onto the awarded_at
    column and removed from the stored JSONB (so backfill gets true historical times;
    live detection gets the real crossing time rather than NOW()). Multi-fire badges
    must include context['window']; single-fire ones omit it (→ NULL window).
    """
    ctx = dict(context)
    awarded_at_iso = ctx.pop("awarded_at", None)
    awarded_at = datetime.fromisoformat(awarded_at_iso) if awarded_at_iso else None

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
                (track_uri, badge_type, json.dumps(ctx)),
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
                (track_uri, badge_type, awarded_at, json.dumps(ctx)),
            )
        inserted = cur.fetchone() is not None
    conn.commit()

    if not inserted:
        return False
    if not send_mail:
        return True

    try:
        subject, html_body, plaintext_body = _build_special_badge_mail(conn, track_uri, badge_type, ctx)
        return _smtp_send(subject, html_body, plaintext_body)
    except Exception as e:
        print(
            f"WARNING: special badge {track_uri} {badge_type} recorded but mail failed: {e}",
            file=sys.stderr,
        )
        return False


# ── Detection: streaks ──────────────────────────────────────────────────────────

def detect_streak_badges(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """streak_5_years / streak_10_years — a track with ≥1 play in each of N consecutive
    calendar years. Gaps-and-islands over the distinct local years per track finds each
    track's longest consecutive run; a run ≥5/≥10 earns the badge (once per track).
    """
    where_batch = ""
    params: list = []
    if batch_track_uris is not None:
        where_batch = "AND sp.track_uri = ANY(%s)"
        params = [batch_track_uris]

    sql = f"""
    WITH years AS (
        SELECT DISTINCT sp.track_uri,
               EXTRACT(YEAR FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam')::int AS yr
        FROM spotify_plays sp
        WHERE sp.track_uri IS NOT NULL
          {where_batch}
    ),
    islands AS (
        SELECT track_uri, yr,
               yr - ROW_NUMBER() OVER (PARTITION BY track_uri ORDER BY yr) AS island
        FROM years
    ),
    runs AS (
        SELECT track_uri, MIN(yr) AS run_start, COUNT(*) AS run_len
        FROM islands
        GROUP BY track_uri, island
    ),
    best AS (
        SELECT DISTINCT ON (track_uri) track_uri, run_start, run_len
        FROM runs
        ORDER BY track_uri, run_len DESC, run_start ASC
    )
    SELECT track_uri, run_start, run_len FROM best WHERE run_len >= 5
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    results: list[tuple[str, str, dict]] = []
    for track_uri, run_start, run_len in rows:
        for n in (5, 10):
            if run_len < n:
                continue
            badge_type = f"streak_{n}_years"
            if _has_badge(conn, track_uri, badge_type):
                continue
            # awarded_at = first play of the Nth consecutive year of the longest run.
            nth_year_first = _first_play_in_year(conn, track_uri, run_start + n - 1)
            ctx = {"longest_streak_years": run_len, "streak_start_year": run_start}
            if nth_year_first is not None:
                ctx["awarded_at"] = nth_year_first.isoformat()
            results.append((track_uri, badge_type, ctx))
    return results


# ── Detection: daily intensity ───────────────────────────────────────────────────

def detect_daily_intensity_badges(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """plays_20_in_day / plays_40_in_day — ≥20/≥40 plays of one track on one local day.
    Multi-fire: context['window'] is the date, so each (track, date) awards at most once.
    """
    where_batch = ""
    batch_params: list = []
    if batch_track_uris is not None:
        where_batch = "AND sp.track_uri = ANY(%s)"
        batch_params = [batch_track_uris]

    results: list[tuple[str, str, dict]] = []
    for n in (20, 40):
        sql = f"""
        WITH daily AS (
            SELECT sp.track_uri,
                   (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS day,
                   COUNT(*) AS plays
            FROM spotify_plays sp
            WHERE sp.track_uri IS NOT NULL
              {where_batch}
            GROUP BY sp.track_uri, day
            HAVING COUNT(*) >= %s
        )
        SELECT d.track_uri, d.day, d.plays
        FROM daily d
        LEFT JOIN badge_events be
          ON be.entity_type = 'track' AND be.entity_id = d.track_uri
          AND be.badge_type = %s AND be.context->>'window' = d.day::text
        WHERE be.id IS NULL
        ORDER BY d.track_uri, d.day
        """
        with conn.cursor() as cur:
            cur.execute(sql, [*batch_params, n, f"plays_{n}_in_day"])
            for track_uri, day, plays in cur.fetchall():
                ctx = {
                    "window": day.isoformat(),
                    "plays_that_day": plays,
                    "awarded_at": _end_of_day_iso(day),
                }
                results.append((track_uri, f"plays_{n}_in_day", ctx))
    return results


# ── Detection: release timing (played_on_release_day) ────────────────────────────

def detect_release_timing_badges(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """played_on_release_day — a track whose FIRST play landed on its release date.
    Requires day-precision release_date in track_metadata. Once per track.

    day_one_stan / late_bloomer are NOT here — they trigger from the plays_50 crossing
    in record_and_notify_milestone (see detect_release_timing_at_50_plays).
    """
    where_batch = ""
    params: list = []
    if batch_track_uris is not None:
        where_batch = "AND sp.track_uri = ANY(%s)"
        params = [batch_track_uris]

    sql = f"""
    WITH firsts AS (
        SELECT sp.track_uri, MIN(sp.played_at) AS first_play_at
        FROM spotify_plays sp
        WHERE sp.track_uri IS NOT NULL
          {where_batch}
        GROUP BY sp.track_uri
    )
    SELECT f.track_uri, f.first_play_at, tm.release_date
    FROM firsts f
    JOIN track_metadata tm ON tm.track_uri = f.track_uri
    LEFT JOIN badge_events be
      ON be.entity_type = 'track' AND be.entity_id = f.track_uri
      AND be.badge_type = 'played_on_release_day' AND be.context->>'window' IS NULL
    WHERE tm.release_date_precision = 'day'
      AND tm.release_date IS NOT NULL
      AND (f.first_play_at AT TIME ZONE 'Europe/Amsterdam')::date = tm.release_date::date
      AND be.id IS NULL
    ORDER BY f.track_uri
    """
    results: list[tuple[str, str, dict]] = []
    with conn.cursor() as cur:
        cur.execute(sql, params)
        for track_uri, first_play_at, release_date in cur.fetchall():
            ctx = {
                "release_date": str(release_date),
                "first_played_at": first_play_at.isoformat(),
                "awarded_at": first_play_at.isoformat(),
            }
            results.append((track_uri, "played_on_release_day", ctx))
    return results


def detect_release_timing_at_50_plays(conn, track_uri: str) -> tuple[str, dict] | None:
    """Called when a track just crossed plays_50. Compares the gap between the track's
    first play and its release date:
      - gap ≤ 7 days   → day_one_stan   (caught it on/around release, then stuck around)
      - gap > 730 days → late_bloomer   (discovered it years later, then binged)
      - otherwise      → None
    Requires day-precision release_date. Both badges are once-per-track.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT tm.release_date, MIN(sp.played_at)
            FROM track_metadata tm
            JOIN spotify_plays sp ON sp.track_uri = tm.track_uri
            WHERE tm.track_uri = %s
              AND tm.release_date_precision = 'day'
              AND tm.release_date IS NOT NULL
            GROUP BY tm.release_date
            """,
            (track_uri,),
        )
        row = cur.fetchone()
    if not row or not row[0] or row[1] is None:
        return None

    release_date = date.fromisoformat(row[0])
    first_play_at = row[1]
    first_play_date = first_play_at.astimezone(TZ_AMSTERDAM).date()
    gap_days = (first_play_date - release_date).days
    ctx = {
        "release_date": release_date.isoformat(),
        "first_play_date": first_play_date.isoformat(),
        "gap_days": gap_days,
        "awarded_at": first_play_at.isoformat(),
    }
    if gap_days <= 7:
        return ("day_one_stan", ctx)
    if gap_days > 730:
        return ("late_bloomer", ctx)
    return None


# ── Detection: comeback ──────────────────────────────────────────────────────────

def detect_comeback_badges(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """comeback — a track with prior history that then went silent for ≥6 consecutive
    months and roared back with ≥20 plays in a single month. Multi-fire on the comeback
    month (context['window'] = 'YYYY-MM').
    """
    where_batch = ""
    params: list = []
    if batch_track_uris is not None:
        where_batch = "AND sp.track_uri = ANY(%s)"
        params = [batch_track_uris]

    sql = f"""
    WITH monthly AS (
        SELECT sp.track_uri,
               date_trunc('month', sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date AS mon,
               COUNT(*) AS plays
        FROM spotify_plays sp
        WHERE sp.track_uri IS NOT NULL
          {where_batch}
        GROUP BY sp.track_uri, mon
    ),
    candidates AS (
        SELECT track_uri, mon, plays FROM monthly WHERE plays >= 20
    )
    SELECT c.track_uri, c.mon, c.plays,
           (SELECT MAX(m.mon) FROM monthly m
             WHERE m.track_uri = c.track_uri AND m.mon < c.mon) AS last_active
    FROM candidates c
    WHERE NOT EXISTS (
        SELECT 1 FROM monthly m
        WHERE m.track_uri = c.track_uri
          AND m.mon >= (c.mon - INTERVAL '6 months')
          AND m.mon <  c.mon
    )
    AND EXISTS (
        SELECT 1 FROM monthly m
        WHERE m.track_uri = c.track_uri
          AND m.mon < (c.mon - INTERVAL '6 months')
    )
    ORDER BY c.track_uri, c.mon
    """
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    results: list[tuple[str, str, dict]] = []
    for track_uri, mon, plays, last_active in rows:
        window = mon.strftime("%Y-%m")
        if _has_badge(conn, track_uri, "comeback", window):
            continue
        ctx = {
            "window": window,
            "plays_that_month": plays,
            "dormant_since": last_active.strftime("%Y-%m") if last_active else None,
            "awarded_at": _end_of_month_iso(mon),
        }
        results.append((track_uri, "comeback", ctx))
    return results


# ── Detection: season_regular ────────────────────────────────────────────────────

def _completed_seasons(today: date, min_d: date, max_d: date) -> list[tuple[str, int, str, date]]:
    """(season, start_year, display_name, period_end) for every completed season that
    overlaps the play-history range, chronological by start date."""
    from lib.seasons import season_start, season_end, season_display_year, MIN_YEAR, MAX_YEAR

    out: list[tuple[str, int, str, date, date]] = []
    for yr in range(MIN_YEAR, MAX_YEAR + 1):
        for season in ("winter", "spring", "summer", "autumn"):
            try:
                start = season_start(season, yr)
                end = season_end(season, yr)
            except ValueError:
                continue
            if end < today and end >= min_d and start <= max_d:
                display = f"{season.capitalize()} {season_display_year(season, yr)}"
                out.append((season, yr, display, end, start))
    out.sort(key=lambda x: x[4])  # chronological by start date
    return [(s, y, d, e) for s, y, d, e, _start in out]


def detect_season_regular_badge(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """season_regular — a track that landed in the top 25 of ≥3 different seasonal
    snapshots. Season top-25 is recomputed deterministically from spotify_plays via
    rank_period_tracks (season snapshots have no stored membership), so no schema is
    needed. Once per track; awarded_at = end of the 3rd qualifying season.
    """
    from lib.playlists import rank_period_tracks

    span = _play_date_span(conn)
    if span is None:
        return []
    min_d, max_d = span
    today = datetime.now(TZ_AMSTERDAM).date()

    # {track_uri: [(display, period_end), ...]} in chronological season order.
    membership: dict[str, list[tuple[str, date]]] = {}
    for season, start_year, display, end in _completed_seasons(today, min_d, max_d):
        try:
            ranked = rank_period_tracks(conn, "season", (season, start_year))
        except ValueError:
            continue
        for t in ranked[:25]:
            membership.setdefault(t["track_uri"], []).append((display, end))

    if batch_track_uris is None:
        candidates = list(membership.keys())
    else:
        candidates = [u for u in set(batch_track_uris) if u in membership]

    results: list[tuple[str, str, dict]] = []
    for uri in candidates:
        seasons_q = membership[uri]
        if len(seasons_q) < 3 or _has_badge(conn, uri, "season_regular"):
            continue
        third_end = seasons_q[2][1]  # end of the 3rd qualifying season = crossing point
        ctx = {
            "seasons_qualified": [d for d, _e in seasons_q],
            "count": len(seasons_q),
            "awarded_at": _end_of_day_iso(third_end),
        }
        results.append((uri, "season_regular", ctx))
    return results


# ── Detection: multi_top ─────────────────────────────────────────────────────────

# A track needs to currently sit in at least this many Top playlists to earn multi_top.
# Chosen (v0.67) over the broad universe below to keep the badge prestigious — see the
# universe docstring. Against ~10 years of data this awards the top ~20-25 tracks.
MULTI_TOP_THRESHOLD = 10


def _multi_top_universe(conn) -> list[tuple[str, list[str]]]:
    """(label, track_uris) for every Top playlist that currently EXISTS, recomputed
    deterministically from spotify_plays (snapshot playlists have no stored membership):

      - 3 updating tops: Top 100 all-time, Top 100 this year, Top 50 last 30 days
      - one snapshot per COMPLETED month (Top 25), season (Top 50) and year (Top 100)
        within the play-history range

    ~160 recomputations against a decade of data — heavy, but this only runs at weekly
    cron completion and in the one-off backfill, never on the hot ingest path.
    """
    from lib.playlists import rank_period_tracks, snapshot_period_spec, query_top_all_time, query_top_recent

    span = _play_date_span(conn)
    if span is None:
        return []
    min_d, max_d = span
    today = datetime.now(TZ_AMSTERDAM).date()

    def _period(kind, identifier) -> tuple[str, list[str]]:
        spec = snapshot_period_spec(kind, identifier)
        try:
            uris = [t["track_uri"] for t in rank_period_tracks(conn, kind, identifier)]
        except ValueError:
            uris = []
        return spec["suffix"], uris

    universe: list[tuple[str, list[str]]] = [
        ("Top 100 all-time", query_top_all_time(100)(conn)),
        ("Top 100 this year", [t["track_uri"] for t in rank_period_tracks(conn, "year", today.year)]),
        ("Top 50 last 30 days", query_top_recent(30, 50)(conn)),
    ]

    # Completed months: from the first play month up to (but excluding) the current month.
    y, m = min_d.year, min_d.month
    while (y, m) < (today.year, today.month):
        universe.append(_period("month", (y, m)))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)

    # Completed years: first play year up to (but excluding) the current year.
    for yr in range(min_d.year, today.year):
        universe.append(_period("year", yr))

    # Completed seasons overlapping the play range.
    for season, start_year, _display, _end in _completed_seasons(today, min_d, max_d):
        universe.append(_period("season", (season, start_year)))

    return [(label, uris) for label, uris in universe if uris]


def detect_multi_top_badge(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """multi_top — a track currently sitting in ≥MULTI_TOP_THRESHOLD Top playlists at once.

    Only the 3 updating tops have *stored* current membership (playlist_rank_history),
    never enough alone. Snapshot tops are deterministic functions of the play history, so
    _multi_top_universe recomputes every currently-existing Top playlist from spotify_plays
    (no Spotify calls, no new schema). Once per track — the badge stays even if the track
    later drops out (the simultaneous-membership achievement happened).
    """
    counts: dict[str, list[str]] = {}
    for label, uris in _multi_top_universe(conn):
        for u in uris:
            counts.setdefault(u, []).append(label)

    if batch_track_uris is None:
        candidates = list(counts.keys())
    else:
        candidates = [u for u in set(batch_track_uris) if u in counts]

    results: list[tuple[str, str, dict]] = []
    for uri in candidates:
        playlists = counts[uri]
        if len(playlists) < MULTI_TOP_THRESHOLD or _has_badge(conn, uri, "multi_top"):
            continue
        # awarded_at intentionally NOW() — this is a live "current state" achievement.
        ctx = {"playlists": playlists, "count": len(playlists)}
        results.append((uri, "multi_top", ctx))
    return results


# ── Per-badge mail template ──────────────────────────────────────────────────────

def _special_subject(badge_type: str, track_name: str, context: dict) -> str:
    window = context.get("window", "")
    return {
        "streak_5_years": f"music-tracker: '{track_name}' just hit a 5-year streak",
        "streak_10_years": f"music-tracker: '{track_name}' — 10-year streak achievement",
        "plays_20_in_day": f"music-tracker: '{track_name}' — 20 plays in one day ({window})",
        "plays_40_in_day": f"music-tracker: '{track_name}' — 40 plays in one day ({window})",
        "played_on_release_day": f"music-tracker: '{track_name}' played on release day",
        "day_one_stan": f"music-tracker: Day-one stan achievement — '{track_name}'",
        "late_bloomer": f"music-tracker: Late bloomer badge — '{track_name}'",
        "comeback": f"music-tracker: '{track_name}' is having a comeback",
        "season_regular": f"music-tracker: '{track_name}' — Season regular achievement",
        "multi_top": f"music-tracker: '{track_name}' hit 5+ Top playlists simultaneously",
    }[badge_type]


# Human-readable headline per badge type, paired with its category emoji at render time.
_SPECIAL_HEADLINE = {
    "streak_5_years": "5-year listening streak",
    "streak_10_years": "10-year listening streak",
    "plays_20_in_day": "20 plays in a single day",
    "plays_40_in_day": "40 plays in a single day",
    "played_on_release_day": "Played on release day",
    "day_one_stan": "Day-one stan",
    "late_bloomer": "Late bloomer",
    "comeback": "Comeback",
    "season_regular": "Season regular",
    "multi_top": "Multi-top (5+ Top playlists)",
}


def _context_rows(badge_type: str, context: dict) -> list[tuple[str, str]]:
    """(label, value) pairs describing a badge's context box, badge-type specific."""
    def _fmt_list(v):
        return ", ".join(str(x) for x in v) if isinstance(v, list) else str(v)

    keys: list[tuple[str, str]] = {
        "streak_5_years": [("streak_start_year", "Streak start"), ("longest_streak_years", "Longest run (yrs)")],
        "streak_10_years": [("streak_start_year", "Streak start"), ("longest_streak_years", "Longest run (yrs)")],
        "plays_20_in_day": [("window", "Day"), ("plays_that_day", "Plays that day")],
        "plays_40_in_day": [("window", "Day"), ("plays_that_day", "Plays that day")],
        "played_on_release_day": [("release_date", "Release date"), ("first_played_at", "First played")],
        "day_one_stan": [("release_date", "Release date"), ("first_play_date", "First played"), ("gap_days", "Gap (days)")],
        "late_bloomer": [("release_date", "Release date"), ("first_play_date", "First played"), ("gap_days", "Gap (days)")],
        "comeback": [("window", "Comeback month"), ("plays_that_month", "Plays that month"), ("dormant_since", "Dormant since")],
        "season_regular": [("count", "Seasons in top 25"), ("seasons_qualified", "Seasons")],
        "multi_top": [("count", "Top playlists"), ("playlists", "In")],
    }.get(badge_type, [])
    rows = []
    for key, label in keys:
        if key in context and context[key] is not None:
            rows.append((label, _fmt_list(context[key])))
    return rows


def _build_special_badge_mail(conn, track_uri: str, badge_type: str, context: dict) -> tuple[str, str, str]:
    """Returns (subject, html, plaintext) for one special-badge crossing. Generic across
    all 10 types — the subject, category emoji, headline, and context box vary by type."""
    track_name, artist_display, total_plays, _first = _track_display(conn, track_uri)
    subject = _special_subject(badge_type, track_name, context)
    emoji = _SPECIAL_BADGE_EMOJI.get(badge_type, "🏅")
    headline = _SPECIAL_HEADLINE.get(badge_type, badge_type)
    rows = _context_rows(badge_type, context)

    context_html = "".join(
        f'<tr><td style="padding:2px 10px 2px 0;color:#888;">{escape(label)}</td>'
        f'<td style="padding:2px 0;">{escape(value)}</td></tr>'
        for label, value in rows
    )
    html_body = "\n".join([
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:640px;\">",
        f'<h2 style="margin:0 0 6px 0;">{emoji} {escape(headline)}</h2>',
        # v0.64-style badge PNG CID embed goes here (same placeholder as the milestone mail).
        f'<p style="font-size:16px;margin:8px 0;"><strong>{escape(track_name)}</strong></p>',
        f'<p style="font-size:14px;color:#555;margin:2px 0;">{escape(artist_display)}</p>',
        '<table style="border-collapse:collapse;font-size:13px;margin:12px 0;">'
        f'<tr><td style="padding:2px 10px 2px 0;color:#888;">Total plays</td>'
        f'<td style="padding:2px 0;"><strong>{total_plays}</strong></td></tr>'
        + context_html
        + "</table>",
        "</body></html>",
    ])

    plain_lines = [
        f"{headline}!",
        "",
        f"Track:       {track_name}",
        f"Artist(s):   {artist_display}",
        f"Total plays: {total_plays}",
    ]
    for label, value in rows:
        plain_lines.append(f"{label}: {value}")
    plaintext_body = "\n".join(plain_lines)

    return subject, html_body, plaintext_body


# ── Special badges strip (Design B, third strip in the milestone mail) ────────────

def _build_special_strip(conn, track_uri: str) -> tuple[str, str]:
    """Returns (html, plaintext) for the special-badges strip: all 10 types in 4 category
    rows, earned vs not-earned, with a ×N multiplier for multi-fire badges. Mirrors the
    rankings strip's compact-when-empty behaviour."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT badge_type, COUNT(*)
            FROM badge_events
            WHERE entity_type = 'track' AND entity_id = %s AND badge_type = ANY(%s)
            GROUP BY badge_type
            """,
            (track_uri, SPECIAL_BADGE_TYPES),
        )
        counts = {bt: c for bt, c in cur.fetchall()}

    earned = sum(1 for bt in SPECIAL_BADGE_TYPES if counts.get(bt, 0) >= 1)
    total = len(SPECIAL_BADGE_TYPES)

    if earned == 0:
        return (
            '<p style="font-size:13px;color:#888;margin:16px 0;">Special badges — none yet 🎯</p>',
            "Special badges — none yet 🎯",
        )

    if earned == total:
        progress = "All 10 special badges earned! 🌟"
    else:
        progress = f"Special badges — {earned} of {total} earned"

    def _slot(bt: str, label: str) -> tuple[str, str]:
        c = counts.get(bt, 0)
        if c >= 1:
            mult = f" ×{c}" if c > 1 else ""
            return (
                f'<span style="color:#ccc;">{escape(label)} ✓{escape(mult)}</span>',
                f"{label} ✓{mult}",
            )
        return (f'<span style="color:#555;">{escape(label)} —</span>', f"{label} —")

    html_rows, plain_rows = [], []
    for cat_label, slots in _SPECIAL_STRIP:
        html_slots, plain_slots = zip(*(_slot(bt, lbl) for bt, lbl in slots))
        html_rows.append(
            f'<tr><td style="padding:4px 12px 4px 0;color:#888;min-width:120px;">{escape(cat_label)}</td>'
            f'<td style="padding:4px 0;">{", ".join(html_slots)}</td></tr>'
        )
        plain_rows.append(f"  {cat_label}: {', '.join(plain_slots)}")

    html = (
        '<div style="margin:16px 0;">'
        f'<p style="font-size:13px;color:#888;margin:0 0 6px 0;">{escape(progress)}</p>'
        '<table style="font-size:13px;color:#ccc;">'
        + "".join(html_rows)
        + "</table></div>"
    )
    plaintext = "\n".join([f"{progress}:", *plain_rows])
    return html, plaintext
