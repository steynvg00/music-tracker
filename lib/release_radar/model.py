"""Release radar (v0.87, R7): the shapes every source adapter returns."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass(frozen=True)
class RadarArtist:
    key: str                 # normalised name (match.norm_artist)
    name: str
    spotify_id: str | None   # 22-char Spotify artist id, when known
    plays: int               # plays in the window (0 for followed-only artists)
    followed: bool = False   # "Follow in Rotor"


@dataclass
class ReleaseItem:
    source: str
    external_id: str
    artist_key: str
    artist_name: str
    title: str
    release_date: date | None
    precision: str | None    # 'day' | 'month' | 'year'
    url: str | None = None
    artist_id: str | None = None
    release_type: str | None = None   # album / single / ep / compilation
    label: str | None = None
    spotify_album_id: str | None = None
    track_uris: list[str] = field(default_factory=list)


@dataclass
class SourceResult:
    items: list[ReleaseItem]
    requests: int = 0
    errors: list[str] = field(default_factory=list)
    detail: dict = field(default_factory=dict)
    fatal: str | None = None   # the source as a whole failed (counts toward the 3-day alert)

    @property
    def ok(self) -> bool:
        return self.fatal is None


class SourceDisabled(Exception):
    """The adapter is switched off (shown as 'disabled' with the reason, never as a failure)."""
