"""Release radar (v0.87, R7): normalisation + matching across sources.

One release can arrive from Spotify, MusicBrainz and a label page with slightly different text
("Sound Rush & Atmozfears – Hold On (Extended Mix)" vs "Hold On"). Two items are the same release
when their normalised artist and normalised title are equal and their dates are within
DATE_WINDOW_DAYS of each other (or one has no day-precise date yet).

Remixes stay distinct ("Hold On (Rebelion Remix)" ≠ "Hold On"): only mix/edit labels that name the
SAME recording are stripped (original/extended/radio/club mix, edit, remaster, feat. credits).
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date

DATE_WINDOW_DAYS = 14

_FEAT = re.compile(r"\s*[\(\[]\s*(feat\.?|ft\.?|featuring|with)\s+[^\)\]]*[\)\]]|\s+(feat\.|ft\.|featuring)\s+.*$", re.I)
_SAME_RECORDING = re.compile(
    r"\s*[\(\[]\s*(original|extended|radio|club|pro|album|single|short|long)?\s*(mix|edit|version|cut)\s*[\)\]]"
    r"|\s*[\(\[]\s*(\d{4}\s+)?remaster(ed)?(\s+\d{4})?\s*[\)\]]"
    r"|\s+-\s+(original|extended|radio|club|pro)\s+(mix|edit|version)\s*$",
    re.I,
)
_SPLIT_ARTISTS = re.compile(r"\s*(?:,|&|\+|\bx\b|\band\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|/)\s*", re.I)
_NON_WORD = re.compile(r"[^\w\s]", re.U)
_SPACES = re.compile(r"\s+")


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.casefold()


def norm_text(s: str) -> str:
    s = _NON_WORD.sub(" ", _fold(s).replace("&", " and "))
    return _SPACES.sub(" ", s).strip()


def norm_title(title: str) -> str:
    t = title or ""
    for _ in range(3):  # "Title (feat. X) (Extended Mix)"
        t2 = _SAME_RECORDING.sub("", _FEAT.sub("", t))
        if t2 == t:
            break
        t = t2
    return norm_text(t)


def split_artists(credit: str) -> list[str]:
    """'Da Tweekaz & Sound Rush feat. X' → ['da tweekaz', 'sound rush', 'x'] (normalised, non-empty)."""
    parts = _SPLIT_ARTISTS.split(_fold(credit or ""))
    return [p for p in (norm_text(x) for x in parts) if p]


def norm_artist(name: str) -> str:
    return norm_text(name)


def credit_matches(credit: str, artist_key: str) -> bool:
    """True when the normalised artist is one of the credited artists (or the whole credit)."""
    if not artist_key:
        return False
    return artist_key == norm_text(credit) or artist_key in split_artists(credit)


def dates_close(a: date | None, b: date | None, window: int = DATE_WINDOW_DAYS) -> bool:
    if a is None or b is None:
        return True
    return abs((a - b).days) <= window


PRECISION_RANK = {"day": 3, "month": 2, "year": 1, None: 0}


def better_date(cur: tuple[date | None, str | None], new: tuple[date | None, str | None]) -> tuple[date | None, str | None]:
    """Keep the more precise date; on a tie keep the current one."""
    if new[0] is None:
        return cur
    if cur[0] is None or PRECISION_RANK.get(new[1], 0) > PRECISION_RANK.get(cur[1], 0):
        return new
    return cur
