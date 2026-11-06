"""Release radar (v0.87, R7): one polite HTTP client for MusicBrainz and label pages.

  * User-Agent: RotorMusicHub/0.87 ( https://github.com/steynvg00/music-tracker ) — the form
    MusicBrainz asks for. No e-mail address in any header.
  * A minimum gap per host (MusicBrainz: 1.1 s, i.e. under 1 request/second; label pages: 4 s).
  * 503 / 429 → wait and retry once; anything else is returned to the caller.
  * `sleep`, `clock` and `transport` are injectable: tests never touch the network.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit

import httpx

USER_AGENT = "RotorMusicHub/0.87 ( https://github.com/steynvg00/music-tracker )"


@dataclass
class PoliteHttp:
    min_gap: dict[str, float] = field(default_factory=dict)   # host → seconds between requests
    default_gap: float = 1.1
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    transport: httpx.BaseTransport | None = None
    timeout: float = 20.0
    _last: dict[str, float] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)

    def __post_init__(self):
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept": "application/json, text/html;q=0.9"},
            timeout=self.timeout, follow_redirects=True, transport=self.transport,
        )

    def _wait(self, host: str) -> None:
        gap = self.min_gap.get(host, self.default_gap)
        last = self._last.get(host)
        if last is not None:
            remaining = gap - (self.clock() - last)
            if remaining > 0:
                self.sleep(remaining)
        self._last[host] = self.clock()

    def get(self, url: str, params: dict | None = None) -> httpx.Response:
        host = urlsplit(url).hostname or ""
        for attempt in range(2):
            self._wait(host)
            r = self._client.get(url, params=params)
            self.log.append(f"GET {r.request.url}")
            if r.status_code in (429, 503) and attempt == 0:
                self.sleep(float(r.headers.get("Retry-After", "2") or 2))
                continue
            return r
        return r

    def close(self) -> None:
        self._client.close()
