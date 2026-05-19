import os
import time
from collections.abc import Iterator

import httpx
from dotenv import load_dotenv

load_dotenv()

_BASE_URL = "https://ws.audioscrobbler.com/2.0/"
_PAGE_SIZE = 200
_MIN_REQUEST_INTERVAL = 0.5  # seconds between requests (~2 req/sec)


class LastfmClient:
    def __init__(self) -> None:
        self.api_key = os.environ.get("LASTFM_API_KEY")
        self.username = os.environ.get("LASTFM_USERNAME")
        if not self.api_key:
            raise RuntimeError("LASTFM_API_KEY environment variable is not set")
        if not self.username:
            raise RuntimeError("LASTFM_USERNAME environment variable is not set")
        self._client = httpx.Client(timeout=30)
        self._last_request_at: float = 0.0

    def _get(self, params: dict) -> dict:
        params = {
            "api_key": self.api_key,
            "format": "json",
            **params,
        }
        for attempt in range(5):
            elapsed = time.monotonic() - self._last_request_at
            if elapsed < _MIN_REQUEST_INTERVAL:
                time.sleep(_MIN_REQUEST_INTERVAL - elapsed)
            self._last_request_at = time.monotonic()

            resp = self._client.get(_BASE_URL, params=params)

            if resp.status_code in (429, 500, 502, 503, 504):
                wait = 2 ** attempt
                time.sleep(wait)
                continue

            resp.raise_for_status()
            return resp.json()

        raise RuntimeError(f"last.fm request failed after retries: {params}")

    def fetch_recent_tracks(self, from_ts: int | None = None) -> Iterator[dict]:
        """Yield track dicts oldest→newest, skipping currently-playing entries."""
        page = 1
        total_pages = None

        while total_pages is None or page <= total_pages:
            params: dict = {
                "method": "user.getrecenttracks",
                "user": self.username,
                "limit": _PAGE_SIZE,
                "page": page,
                "extended": 0,
            }
            if from_ts is not None:
                params["from"] = from_ts

            data = self._get(params)
            attr = data["recenttracks"]["@attr"]
            total_pages = int(attr["totalPages"])

            tracks = data["recenttracks"]["track"]
            if isinstance(tracks, dict):
                tracks = [tracks]

            # last.fm returns newest-first; reverse each page so we go oldest→newest
            for track in reversed(tracks):
                if "date" not in track:
                    continue  # skip currently-playing
                yield track

            page += 1
