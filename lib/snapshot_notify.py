"""Snapshot-creation mail (v0.65).

Sent by the daily create-snapshots cron the moment a period snapshot playlist is
created: a #1-track spotlight box + the full ranked tracklist. Reuses the shared
_smtp_send transport from v0.62/v0.63 and follows the same non-fatal semantics —
a mail failure never breaks the cron.
"""

from __future__ import annotations

import sys
from html import escape
from typing import Literal

from lib.email_notify import _smtp_send


def _build_snapshot_mail(
    kind: str,
    display_name: str,
    playlist_name: str,
    ranked_tracks: list[dict],
) -> tuple[str, str, str]:
    """Returns (subject, html_body, plaintext_body)."""
    subject = f"music-tracker: {display_name} snapshot ready"
    top = ranked_tracks[0]

    # HTML rows for the full tracklist.
    rows_html = []
    for t in ranked_tracks:
        rows_html.append(
            "<tr>"
            f'<td style="padding:4px 8px 4px 0;color:#888;text-align:left;">{t["rank"]}</td>'
            f'<td style="padding:4px 8px;">{escape(t["track_name"])}</td>'
            f'<td style="padding:4px 8px;color:#555;">{escape(t["artist_display"])}</td>'
            f'<td style="padding:4px 0 4px 8px;text-align:right;">{t["plays_in_period"]}</td>'
            "</tr>"
        )

    html_body = "\n".join([
        "<html><body style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#222;max-width:640px;\">",
        f'<h2 style="margin:0 0 6px 0;">📸 {escape(display_name)} snapshot ready</h2>',
        f'<p style="font-size:14px;color:#555;margin:4px 0 16px 0;">{escape(playlist_name)}</p>',
        '<div style="background:#1a2540;padding:12px 16px;border-radius:6px;margin:12px 0;">',
        '<p style="margin:0 0 4px 0;font-size:12px;color:#888;">🥇 #1 THIS PERIOD</p>',
        f'<p style="margin:0;font-size:16px;color:#fff;"><strong>{escape(top["track_name"])}</strong></p>',
        f'<p style="margin:2px 0 0 0;font-size:13px;color:#aaa;">'
        f'{escape(top["artist_display"])} — {top["plays_in_period"]} plays</p>',
        "</div>",
        '<h3 style="margin:20px 0 8px 0;font-size:14px;color:#666;">Full tracklist</h3>',
        '<table style="border-collapse:collapse;font-size:13px;width:100%;">',
        '<tr style="color:#888;">'
        '<th style="text-align:left;padding:6px 8px 6px 0;">#</th>'
        '<th style="text-align:left;padding:6px 8px;">Track</th>'
        '<th style="text-align:left;padding:6px 8px;">Artist</th>'
        '<th style="text-align:right;padding:6px 0 6px 8px;">Plays</th></tr>',
        "".join(rows_html),
        "</table>",
        "</body></html>",
    ])

    plain_lines = [
        f"📸 {display_name} snapshot ready",
        playlist_name,
        "",
        "🥇 #1 THIS PERIOD",
        f"  {top['track_name']} — {top['artist_display']} ({top['plays_in_period']} plays)",
        "",
        "Full tracklist:",
    ]
    for t in ranked_tracks:
        plain_lines.append(
            f"  {t['rank']}. {t['track_name']} — {t['artist_display']} ({t['plays_in_period']} plays)"
        )
    plaintext_body = "\n".join(plain_lines)

    return subject, html_body, plaintext_body


def build_and_send_snapshot_mail(
    conn,
    kind: Literal["month", "season", "year", "alltime", "decade"],
    display_name: str,
    playlist_name: str,
    ranked_tracks: list[dict],
) -> bool:
    """Sends the snapshot creation mail. Returns True on success, False on skip/error.

    Non-fatal like all v0.62+ mail sends — exceptions are caught and logged.
    """
    if not ranked_tracks:
        print(f"[snapshot-mail] No tracks for {display_name}; skipping mail.", flush=True)
        return False
    try:
        subject, html_body, plaintext_body = _build_snapshot_mail(
            kind, display_name, playlist_name, ranked_tracks
        )
        return _smtp_send(subject, html_body, plaintext_body)
    except Exception as e:
        print(f"WARNING: snapshot mail for {display_name} failed: {e}", file=sys.stderr)
        return False
