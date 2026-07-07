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
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from html import escape
from io import BytesIO
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from PIL import Image

from lib.email_notify import _smtp_send_with_inline_images

TZ_AMSTERDAM = ZoneInfo("Europe/Amsterdam")

# ── v0.68: badge PNG icons (Defqon.1 hardstyle set) ───────────────────────────────
# Maps each badge_type to its PNG file under assets/badges/. Complete at 22/22 as of
# v0.70 (late_bloomer → slow_burn.png). _badge_png_bytes still returns None for any
# unmapped/missing file so callers keep their text-placeholder fallback.
BADGE_ICONS: dict[str, str] = {
    # Play milestones
    "plays_50": "50_plays.png",
    "plays_100": "100_plays.png",
    "plays_200": "200_plays.png",
    "plays_300": "300_plays.png",
    "plays_400": "400_plays.png",
    "plays_500": "500_plays.png",
    # Rankings
    "top_1st_month": "month_1.png",
    "top_1st_season": "season_1.png",
    "top_1st_year": "year_1.png",
    "top_1st_alltime": "mythic.png",
    "top_1st_decade": "legend.png",
    # Streaks
    "streak_5_years": "loyalist.png",
    "streak_10_years": "immortal.png",
    # Daily intensity
    "plays_20_in_day": "binge.png",
    "plays_40_in_day": "obsession.png",
    # Release timing
    "played_on_day_one": "first_spin.png",
    "day_one_fan": "day_one.png",
    "release_week_fan": "fresh_cut.png",
    "late_bloomer": "slow_burn.png",
    # Behavioral
    "comeback": "revival.png",
    "season_regular": "evergreen.png",
    "multi_top": "reigning.png",
}

BADGE_ASSETS_DIR = Path(__file__).parent.parent / "assets" / "badges"


@lru_cache(maxsize=256)
def _badge_png_bytes(badge_type: str, size: int, desaturated: bool = False) -> bytes | None:
    """Returns resized PNG bytes for a badge_type, or None if the file isn't present.

    - size: target square dimension in px (thumbnail preserves aspect but our PNGs are
      1024×1024 square).
    - desaturated: if True, convert to greyscale + 40% opacity for the 'not earned' render.

    Cached indefinitely — badges don't change during a process lifetime.

    Fallback semantic: callers check for None and fall back to the text placeholder.
    """
    filename = BADGE_ICONS.get(badge_type)
    if not filename:
        return None
    path = BADGE_ASSETS_DIR / filename
    if not path.exists():
        return None

    img = Image.open(path).convert("RGBA")

    if desaturated:
        # Convert to greyscale, keep alpha, then reduce opacity to 40%.
        grey = img.convert("LA").convert("RGBA")
        alpha = grey.split()[3]
        alpha = alpha.point(lambda x: int(x * 0.4))
        grey.putalpha(alpha)
        img = grey

    img.thumbnail((size, size), Image.LANCZOS)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _badge_cid(badge_type: str, size: int, desaturated: bool = False) -> str:
    """Deterministic CID for a badge/size/state combo. Used in HTML img src and MIME headers."""
    suffix = f"_{size}"
    if desaturated:
        suffix += "_desat"
    return f"badge_{badge_type}{suffix}@music-tracker"


def _badge_img_html(
    inline_images: dict[str, bytes],
    badge_type: str,
    size: int,
    *,
    desaturated: bool = False,
    alt: str = "",
    width: int | None = None,
    height: int | None = None,
    style: str = "",
) -> str | None:
    """Returns an <img src="cid:..."> tag for a badge, registering its PNG bytes into
    inline_images so the sender can embed them. Returns None when the PNG is absent — the
    caller then renders its existing text placeholder (graceful degrade for late_bloomer)."""
    png = _badge_png_bytes(badge_type, size, desaturated)
    if png is None:
        return None
    cid = _badge_cid(badge_type, size, desaturated)
    inline_images[cid] = png
    w = width if width is not None else size
    h = height if height is not None else size
    style_attr = f' style="{style}"' if style else ""
    return f'<img src="cid:{cid}" width="{w}" height="{h}" alt="{escape(alt)}"{style_attr}>'

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
# v0.67.1: release-timing family now scopes on plays WITHIN the time window (not total
# plays). played_on_day_one = heard it on release day; day_one_fan = ≥20 plays on release
# day itself; release_week_fan = ≥50 plays across release week (days 0-7, inclusive of day
# one — cascade is by design); late_bloomer = discovered >2y late AND ≥30 plays in the
# first 90 days after first play.
RELEASE_TIMING_BADGE_TYPES = ["played_on_day_one", "day_one_fan", "release_week_fan", "late_bloomer"]
BEHAVIORAL_BADGE_TYPES = ["comeback", "season_regular", "multi_top"]

SPECIAL_BADGE_TYPES = (
    STREAK_BADGE_TYPES
    + DAILY_INTENSITY_BADGE_TYPES
    + RELEASE_TIMING_BADGE_TYPES
    + BEHAVIORAL_BADGE_TYPES
)

# v0.67.2: badge types that are awarded to badge_events but NEVER trigger a mail on live
# detection — too high-volume (5-10/day for an active listener) for a per-crossing mail to
# stay valuable. They remain fully visible in the milestone-mail Special strip and Track
# lookup (v0.70); they're just passive achievement flags. award_special_badge skips the mail
# for these, and BadgeAwardCollector excludes them from the coalesced ingest digest entirely.
SILENT_BADGE_TYPES = {"played_on_day_one"}

# Special strip layout — 4 category rows, each a (emoji-label, [(badge_type, slot_label)]).
# Kept parallel to the *_BADGE_TYPES lists so the strip and detection share one order.
_SPECIAL_STRIP: list[tuple[str, list[tuple[str, str]]]] = [
    ("🔥 Streaks", [("streak_5_years", "5-year"), ("streak_10_years", "10-year")]),
    ("⚡ Daily intensity", [("plays_20_in_day", "20 in a day"), ("plays_40_in_day", "40 in a day")]),
    ("🎬 Release timing", [
        ("played_on_day_one", "Played on day one"),
        ("day_one_fan", "Day-one fan"),
        ("release_week_fan", "Release-week fan"),
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


def _build_milestone_mail(conn, track_uri: str, threshold: int) -> tuple[str, str, str, dict[str, bytes]]:
    """Returns (subject, html_body, plaintext_body, inline_images) for one milestone crossing.

    inline_images maps CID -> PNG bytes for every badge icon the HTML references; the caller
    passes it to _smtp_send_with_inline_images. Empty when no PNGs resolve (text fallback)."""
    track_name, artist_display, total_plays, first_played_at = _track_display(conn, track_uri)
    first_play_str = first_played_at.date().isoformat() if first_played_at is not None else "unknown"

    subject = f"music-tracker: '{track_name}' just hit {threshold}+ plays"

    # v0.68: badge PNG icons collected here during rendering, embedded via CID by the sender.
    inline_images: dict[str, bytes] = {}

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

    # v0.68: badge PNG icons (48px) replace the ✓/— text placeholders. Earned = full colour,
    # not-earned = desaturated 40%-opacity. If a PNG is missing (None), fall back to the
    # v0.67.1 coloured-block text cell so nothing breaks visually.
    strip_cells = []
    for n, ok in earned_flags:
        img = _badge_img_html(
            inline_images, f"plays_{n}", 48,
            desaturated=not ok,
            alt=f"{n} plays" + ("" if ok else " (not earned)"),
            style="display:block;margin:0 auto;",
        )
        if img is not None:
            label_color = "#4a5" if ok else "#666"
            strip_cells.append(
                '<td style="padding:6px 10px;text-align:center;min-width:64px;">'
                f'{img}'
                f'<div style="font-weight:bold;font-size:12px;color:{label_color};">{n}</div></td>'
            )
        elif ok:
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
            # v0.68: a 32px rank badge PNG (full colour when won, desaturated otherwise) next
            # to the label. Missing PNG → label text only.
            icon = _badge_img_html(
                inline_images, f"top_1st_{kind}", 32,
                desaturated=not windows,
                alt=label,
                style="vertical-align:middle;margin-right:8px;",
            )
            label_cell = (
                f'<td style="padding:4px 12px 4px 0;color:#888;min-width:100px;'
                'vertical-align:middle;">'
                f'{icon or ""}{escape(label)}</td>'
            )
            ranking_rows.append(f'<tr>{label_cell}{value_cell}</tr>')
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
    special_html, special_plain = _build_special_strip(conn, track_uri, inline_images)

    # v0.68: 96px milestone-tier badge PNG in the header, replacing the 🏆 emoji. Falls back
    # to the emoji header when the PNG isn't present.
    header_img = _badge_img_html(
        inline_images, f"plays_{threshold}", 96,
        alt=f"{threshold}+ plays",
        style="vertical-align:middle;",
    )
    if header_img is not None:
        header_html = (
            '<h2 style="display:flex;align-items:center;gap:12px;margin:0 0 6px 0;">'
            f'{header_img}{threshold}+ plays milestone</h2>'
        )
    else:
        header_html = f'<h2 style="margin:0 0 6px 0;">🏆 {threshold}+ plays milestone</h2>'

    html_body = "\n".join([
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:640px;\">",
        header_html,
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

    return subject, html_body, plaintext_body, inline_images


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
        subject, html_body, plaintext_body, inline_images = _build_milestone_mail(conn, track_uri, threshold)
        mail_sent = _smtp_send_with_inline_images(subject, html_body, plaintext_body, inline_images)
    except Exception as e:
        print(
            f"WARNING: badge {track_uri} plays_{threshold} recorded but mail failed: {e}",
            file=sys.stderr,
        )
        mail_sent = False

    # v0.67.1: crossing plays_50 is the trigger point for the window-scoped release-timing
    # badges (day_one_fan / release_week_fan / late_bloomer). detect_* returns ALL that
    # apply — day_one_fan and release_week_fan can both fire. Non-fatal: a failure here
    # must not undo the play-milestone result. Each is once-per-track; the windowed index
    # dedupes re-runs.
    if threshold == 50:
        try:
            for badge_type_earned, ctx in detect_release_timing_at_50_plays(conn, track_uri):
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

    Returns True if the row was newly inserted and (mailed OR send_mail=False OR the badge
    type is silent); False on a UNIQUE conflict (already awarded) or a post-insert mail
    failure (row is kept — the badge WAS earned — and a warning is logged, same non-fatal
    pattern as v0.63). Silent badges (SILENT_BADGE_TYPES) never mail on live detection.

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
    # Silent badges (v0.67.2) are row-only: inserted, but never mailed on live detection.
    if not send_mail or badge_type in SILENT_BADGE_TYPES:
        return True

    try:
        subject, html_body, plaintext_body, inline_images = _build_special_badge_mail(conn, track_uri, badge_type, ctx)
        return _smtp_send_with_inline_images(subject, html_body, plaintext_body, inline_images)
    except Exception as e:
        print(
            f"WARNING: special badge {track_uri} {badge_type} recorded but mail failed: {e}",
            file=sys.stderr,
        )
        return False


# ── v0.67.2: coalesced ingest-run badge digest ───────────────────────────────────

@dataclass
class BadgeAwardCollector:
    """Collects badges awarded during one ingest cron run for a single coalesced mail.

    Silent badges (SILENT_BADGE_TYPES, e.g. played_on_day_one) are excluded entirely —
    they are row-only and never mailed, so they never enter the digest.
    """

    awards: list[tuple[str, str, dict]] = field(default_factory=list)  # (track_uri, badge_type, context)

    def add(self, track_uri: str, badge_type: str, context: dict) -> None:
        if badge_type in SILENT_BADGE_TYPES:
            return
        self.awards.append((track_uri, badge_type, context))

    def has_awards(self) -> bool:
        return len(self.awards) > 0


def award_special_badge_to_collector(
    conn,
    collector: BadgeAwardCollector,
    track_uri: str,
    badge_type: str,
    context: dict,
) -> bool:
    """Insert the badge (award_special_badge with send_mail=False) and, if newly inserted,
    add it to the collector for the end-of-run digest. Returns True if newly inserted,
    False on a UNIQUE conflict (already awarded) — keeping detection loops idempotent while
    coalescing all this run's mails into one.

    Silent badges still get inserted here; the collector's add() drops them from the digest.
    """
    inserted = award_special_badge(conn, track_uri, badge_type, context, send_mail=False)
    if inserted:
        collector.add(track_uri, badge_type, context)
    return inserted


def _badge_digest_metric(badge_type: str, context: dict) -> str:
    """Short per-badge context line for the coalesced ingest digest."""
    if badge_type == "streak_5_years":
        return "5-year streak reached"
    if badge_type == "streak_10_years":
        return "10-year streak reached"
    if badge_type in ("plays_20_in_day", "plays_40_in_day"):
        n, day = context.get("plays_that_day"), context.get("window")
        return f"{n} plays on {day}" if n and day else "daily-intensity milestone"
    if badge_type == "comeback":
        n, mon = context.get("plays_that_month"), context.get("window")
        return f"{n} plays in {mon}" if n and mon else "comeback"
    if badge_type == "day_one_fan":
        return f"{context.get('plays_on_release_day', '?')} plays on release day"
    if badge_type == "release_week_fan":
        return f"{context.get('plays_in_release_week', '?')} plays in release week"
    if badge_type == "late_bloomer":
        return f"discovered {context.get('gap_days', '?')}d after release"
    if badge_type == "season_regular":
        return f"top 25 of {context.get('count', '?')} seasons"
    if badge_type == "multi_top":
        return f"in {context.get('count', '?')} Top playlists"
    if badge_type == "played_on_day_one":
        return "played on release day"
    return ""


def _build_badge_digest(conn, awards: list[tuple[str, str, dict]]) -> tuple[str, str, dict[str, bytes]]:
    """(html, plaintext, inline_images) for a coalesced badge digest, grouped by badge_type in
    the canonical SPECIAL_BADGE_TYPES order. Each group: emoji + headline header, then a
    track/artist/metric table with a 32px badge icon (v0.68) on each row. Track names/artists
    via the same DISTINCT ON pattern (Lesson #18b) as _track_display.
    """
    inline_images: dict[str, bytes] = {}
    grouped: dict[str, list[tuple[str, dict]]] = {}
    for track_uri, badge_type, context in awards:
        grouped.setdefault(badge_type, []).append((track_uri, context))

    ordered_types = [bt for bt in SPECIAL_BADGE_TYPES if bt in grouped]
    ordered_types += [bt for bt in grouped if bt not in SPECIAL_BADGE_TYPES]  # defensive tail

    n = len(awards)
    plural = "s" if n != 1 else ""
    html_parts = [
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:640px;\">",
        f'<h2 style="margin:0 0 6px 0;">🏅 {n} new special badge{plural}</h2>',
    ]
    plain_parts = [f"{n} new special badge{plural}", ""]

    for badge_type in ordered_types:
        entries = grouped[badge_type]
        emoji = _SPECIAL_BADGE_EMOJI.get(badge_type, "🏅")
        headline = _SPECIAL_HEADLINE.get(badge_type, badge_type)
        html_parts.append(
            f'<h3 style="margin:16px 0 4px 0;font-size:15px;">{emoji} {escape(headline)} '
            f'<span style="font-size:12px;font-weight:normal;color:#888;">({len(entries)})</span></h3>'
        )
        plain_parts.append(f"{emoji} {headline} ({len(entries)}):")

        # v0.68: 32px badge icon on each row of this subsection. Shared CID across rows of the
        # same badge_type → one inline image. Missing PNG → no icon cell (plaintext unchanged).
        row_icon = _badge_img_html(
            inline_images, badge_type, 32,
            alt=headline,
            style="vertical-align:middle;",
        )
        icon_cell = f'<td style="padding:2px 8px 2px 0;vertical-align:middle;">{row_icon}</td>' if row_icon else ""

        rows = []
        for track_uri, context in entries:
            track_name, artist_display, _total, _first = _track_display(conn, track_uri)
            metric = _badge_digest_metric(badge_type, context)
            rows.append(
                f'<tr>{icon_cell}<td style="padding:2px 10px 2px 0;">{escape(track_name)}</td>'
                f'<td style="padding:2px 10px 2px 0;color:#555;">{escape(artist_display)}</td>'
                f'<td style="padding:2px 0;color:#888;">{escape(metric)}</td></tr>'
            )
            suffix = f" ({metric})" if metric else ""
            plain_parts.append(f"  - {track_name} — {artist_display}{suffix}")

        html_parts.append(
            '<table style="border-collapse:collapse;font-size:13px;margin:2px 0 8px 0;">'
            + "".join(rows)
            + "</table>"
        )
        plain_parts.append("")

    html_parts.append("</body></html>")
    return "\n".join(html_parts), "\n".join(plain_parts), inline_images


def send_badge_digest_mail(conn, collector: BadgeAwardCollector) -> bool:
    """Send one coalesced mail for all badges awarded in this ingest run. Returns False and
    sends nothing when the collector has no (non-silent) awards. Non-fatal: a mail failure is
    logged and swallowed so the ingest cron never fails on notification."""
    if not collector.has_awards():
        return False

    n = len(collector.awards)
    subject = f"music-tracker: {n} new special badge{'s' if n != 1 else ''}"
    try:
        html, plaintext, inline_images = _build_badge_digest(conn, collector.awards)
        return _smtp_send_with_inline_images(subject, html, plaintext, inline_images)
    except Exception as e:
        print(f"WARNING: badge digest mail failed: {e}", file=sys.stderr)
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


# ── Detection: release timing (played_on_day_one) ────────────────────────────────

def detect_release_timing_badges(conn, batch_track_uris: list[str] | None = None) -> list[tuple[str, str, dict]]:
    """played_on_day_one — a track whose FIRST play landed on its release date (heard it
    on day one; no play-count threshold). Requires day-precision release_date. Once per
    track.

    day_one_fan / release_week_fan / late_bloomer are NOT here — they scope on plays within
    a time window and trigger from the plays_50 crossing in record_and_notify_milestone
    (see detect_release_timing_at_50_plays).
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
      AND be.badge_type = 'played_on_day_one' AND be.context->>'window' IS NULL
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
            results.append((track_uri, "played_on_day_one", ctx))
    return results


def detect_release_timing_at_50_plays(conn, track_uri: str) -> list[tuple[str, dict]]:
    """Called when a track just crossed plays_50. Runs three INDEPENDENT window-scoped
    checks and returns every applicable release-timing badge (possibly several, possibly
    none):

      - day_one_fan      ≥20 plays ON release day itself (gap 0)
      - release_week_fan ≥50 plays within release week (days 0-7, inclusive of day one)
      - late_bloomer     first play >730 days after release AND ≥30 plays within the
                         first 90 days after that first play

    day_one_fan and release_week_fan can BOTH apply (a 50-on-day-0 track earns both — the
    cascade is by design). late_bloomer is mutually exclusive with them: a >2y gap means
    zero release-day/week plays. All three are once-per-track. Requires day-precision
    release_date; returns [] if none apply.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                tm.release_date,
                MIN(sp.played_at) AS first_play_at,
                COUNT(*) FILTER (
                    WHERE (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date = tm.release_date::date
                ) AS plays_on_release_day,
                COUNT(*) FILTER (
                    WHERE (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date
                          BETWEEN tm.release_date::date AND tm.release_date::date + 7
                ) AS plays_in_release_week
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
        return []

    release_date = date.fromisoformat(row[0])
    first_play_at = row[1]
    plays_on_release_day = row[2]
    plays_in_release_week = row[3]
    first_play_date = first_play_at.astimezone(TZ_AMSTERDAM).date()
    gap_days = (first_play_date - release_date).days

    results: list[tuple[str, dict]] = []

    # ≥20 plays on release day itself → day_one_fan. awarded_at = close of release day.
    if plays_on_release_day >= 20:
        results.append(("day_one_fan", {
            "plays_on_release_day": plays_on_release_day,
            "release_date": release_date.isoformat(),
            "awarded_at": _end_of_day_iso(release_date),
        }))

    # ≥50 plays across the release week → release_week_fan. awarded_at = close of week.
    if plays_in_release_week >= 50:
        results.append(("release_week_fan", {
            "plays_in_release_week": plays_in_release_week,
            "release_date": release_date.isoformat(),
            "awarded_at": _end_of_day_iso(release_date + timedelta(days=7)),
        }))

    # >2y discovery gap AND a real binge (≥30 plays in first 90 days) → late_bloomer.
    if gap_days > 730:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM spotify_plays
                WHERE track_uri = %s
                  AND played_at BETWEEN %s AND %s
                """,
                (track_uri, first_play_at, first_play_at + timedelta(days=90)),
            )
            plays_within_90d = cur.fetchone()[0]
        if plays_within_90d >= 30:
            results.append(("late_bloomer", {
                "gap_days": gap_days,
                "plays_within_90d_of_first_play": plays_within_90d,
                "release_date": release_date.isoformat(),
                "first_played": first_play_date.isoformat(),
                "awarded_at": first_play_at.isoformat(),
            }))

    return results


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
        "played_on_day_one": f"music-tracker: '{track_name}' played on day one",
        "day_one_fan": f"music-tracker: Day-one fan achievement — '{track_name}'",
        "release_week_fan": f"music-tracker: Release-week fan — '{track_name}'",
        "late_bloomer": f"music-tracker: Late bloomer badge — '{track_name}'",
        "comeback": f"music-tracker: '{track_name}' is having a comeback",
        "season_regular": f"music-tracker: '{track_name}' — Season regular achievement",
        "multi_top": f"music-tracker: '{track_name}' hit 10+ Top playlists simultaneously",
    }[badge_type]


# Human-readable headline per badge type, paired with its category emoji at render time.
_SPECIAL_HEADLINE = {
    "streak_5_years": "5-year listening streak",
    "streak_10_years": "10-year listening streak",
    "plays_20_in_day": "20 plays in a single day",
    "plays_40_in_day": "40 plays in a single day",
    "played_on_day_one": "Played on day one",
    "day_one_fan": "Day-one fan",
    "release_week_fan": "Release-week fan",
    "late_bloomer": "Late bloomer",
    "comeback": "Comeback",
    "season_regular": "Season regular",
    "multi_top": "Multi-top (10+ Top playlists)",
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
        "played_on_day_one": [("release_date", "Release date"), ("first_played_at", "First played")],
        "day_one_fan": [("plays_on_release_day", "Plays on release day"), ("release_date", "Release date")],
        "release_week_fan": [("plays_in_release_week", "Plays within release week (day 0-7)"), ("release_date", "Release date")],
        "late_bloomer": [
            ("release_date", "Release date"), ("first_played", "First played"),
            ("gap_days", "Gap (days)"), ("plays_within_90d_of_first_play", "Plays in first 90 days"),
        ],
        "comeback": [("window", "Comeback month"), ("plays_that_month", "Plays that month"), ("dormant_since", "Dormant since")],
        "season_regular": [("count", "Seasons in top 25"), ("seasons_qualified", "Seasons")],
        "multi_top": [("count", "Top playlists"), ("playlists", "In")],
    }.get(badge_type, [])
    rows = []
    for key, label in keys:
        if key in context and context[key] is not None:
            rows.append((label, _fmt_list(context[key])))
    return rows


def _build_special_badge_mail(conn, track_uri: str, badge_type: str, context: dict) -> tuple[str, str, str, dict[str, bytes]]:
    """Returns (subject, html, plaintext, inline_images) for one special-badge crossing.
    Generic across all special types — the subject, category emoji, headline, and context
    box vary by type. inline_images carries the header badge PNG (empty on text fallback)."""
    track_name, artist_display, total_plays, _first = _track_display(conn, track_uri)
    subject = _special_subject(badge_type, track_name, context)
    emoji = _SPECIAL_BADGE_EMOJI.get(badge_type, "🏅")
    headline = _SPECIAL_HEADLINE.get(badge_type, badge_type)
    rows = _context_rows(badge_type, context)

    inline_images: dict[str, bytes] = {}

    context_html = "".join(
        f'<tr><td style="padding:2px 10px 2px 0;color:#888;">{escape(label)}</td>'
        f'<td style="padding:2px 0;">{escape(value)}</td></tr>'
        for label, value in rows
    )

    # v0.68: 128px badge PNG to the left of the headline; the category emoji stays in the
    # headline text as a family indicator. Falls back to the emoji-only header if no PNG.
    header_img = _badge_img_html(
        inline_images, badge_type, 128,
        alt=headline,
        style="vertical-align:middle;",
    )
    if header_img is not None:
        header_html = (
            '<h2 style="display:flex;align-items:center;gap:16px;margin:0 0 6px 0;">'
            f'{header_img}<span>{emoji} {escape(headline)}</span></h2>'
        )
    else:
        header_html = f'<h2 style="margin:0 0 6px 0;">{emoji} {escape(headline)}</h2>'

    html_body = "\n".join([
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:640px;\">",
        header_html,
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

    return subject, html_body, plaintext_body, inline_images


# ── Special badges strip (Design B, third strip in the milestone mail) ────────────

def _build_special_strip(conn, track_uri: str, inline_images: dict[str, bytes]) -> tuple[str, str]:
    """Returns (html, plaintext) for the special-badges strip: all special types in 4
    category rows, earned vs not-earned, with a ×N multiplier for multi-fire badges.
    Mirrors the rankings strip's compact-when-empty behaviour.

    v0.68: each slot renders a 48px badge PNG (earned = full colour, not-earned =
    desaturated) with the label underneath; registers CIDs into inline_images. A missing
    PNG (late_bloomer) degrades to the v0.67.1 coloured text span."""
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
        progress = f"All {total} special badges earned! 🌟"
    else:
        progress = f"Special badges — {earned} of {total} earned"

    def _slot(bt: str, label: str) -> tuple[str, str]:
        c = counts.get(bt, 0)
        earned = c >= 1
        mult = f" ×{c}" if c > 1 else ""
        img = _badge_img_html(
            inline_images, bt, 48,
            desaturated=not earned,
            alt=label,
            style="display:block;margin:0 auto;",
        )
        if img is not None:
            label_color = "#4a5" if earned else "#666"
            label_txt = f"{label}{mult}" if earned else label
            html = (
                '<div style="display:inline-block;vertical-align:top;text-align:center;'
                'width:88px;margin:0 6px 8px 0;">'
                f'{img}'
                f'<div style="font-size:11px;color:{label_color};margin-top:2px;">{escape(label_txt)}</div></div>'
            )
            plain = f"{label} ✓{mult}" if earned else f"{label} —"
            return html, plain
        # PNG missing (late_bloomer) — v0.67.1 coloured text span fallback.
        if earned:
            return (
                f'<span style="color:#ccc;">{escape(label)} ✓{escape(mult)}</span>',
                f"{label} ✓{mult}",
            )
        return (f'<span style="color:#555;">{escape(label)} —</span>', f"{label} —")

    html_rows, plain_rows = [], []
    for cat_label, slots in _SPECIAL_STRIP:
        html_slots, plain_slots = zip(*(_slot(bt, lbl) for bt, lbl in slots))
        # PNG slots are inline-block cells with their own margins → join without commas;
        # plaintext keeps the comma-joined layout unchanged.
        html_rows.append(
            f'<tr><td style="padding:4px 12px 4px 0;color:#888;min-width:120px;'
            f'vertical-align:top;">{escape(cat_label)}</td>'
            f'<td style="padding:4px 0;">{" ".join(html_slots)}</td></tr>'
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
