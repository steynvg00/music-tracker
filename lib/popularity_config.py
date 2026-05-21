"""Configurable constants for track and artist popularity scoring.

To tune the scoring formulas, edit values here and re-run:
    uv run python scripts/compute_track_popularity_scores.py
    uv run python scripts/compute_artist_popularity_scores.py

All windows are in their natural unit (days for date windows, hours for sessions).
"""

# ─── Track popularity (v0.42) ──────────────────────────────────────────────

MIN_PLAYS_FOR_TRACK_SCORING = 20
"""Minimum total plays for a track to be included in track popularity scoring."""

TRACK_STICKY_WINDOW_DAYS = 90
"""Days back from now to consider for the Sticky (recent obsession) sub-score."""

TRACK_SESSION_WINDOW_HOURS = 2
"""Maximum gap between plays (in hours) for them to count as part of the same session loop."""

TRACK_FLASH_HIT_WINDOW_DAYS = 90
"""Window size for Flash Hit detection — looks for the densest N-day cluster of plays."""

TRACK_FLASH_HIT_RATIO_THRESHOLD = 0.5
"""Minimum fraction of total plays falling within the densest window to qualify as a flash hit."""

TRACK_FLASH_HIT_MIN_PLAYS = 30
"""Minimum total play count for a track to be eligible for Flash Hit scoring at all."""

TRACK_COMPOSITE_WEIGHTS = {
    "plays_log_pct": 0.4,
    "sticky": 0.2,
    "evergreen": 0.2,
    "flash_hit": 0.1,
    "session_loop": 0.1,
}
"""Weighted blend for the Composite score (must sum to 1.0)."""

# ─── Artist popularity (v0.44) ─────────────────────────────────────────────

MIN_PLAYS_FOR_ARTIST_SCORING = 100
"""Minimum total plays for an artist to be included in artist popularity scoring."""

ARTIST_STICKY_WINDOW_DAYS = 90
"""Days back from now to consider for the artist Sticky (recent obsession) sub-score."""

ARTIST_DEPTH_MIN_PLAYS_PER_TRACK = 5
"""A track contributes to Depth only if it has at least this many plays from the artist."""

ARTIST_COMPOSITE_WEIGHTS = {
    "plays_log_pct": 0.30,
    "sticky": 0.20,
    "evergreen": 0.20,
    "depth": 0.10,
    "saved": 0.10,
    "devotion": 0.10,
}
"""Weighted blend for the artist Composite score (must sum to 1.0)."""
