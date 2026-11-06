"""Release radar source 3: label release pages — Scantraxx's monthly overview.

  https://www.scantraxx.com/news/releases-scantraxx-<month>-<year>   (e.g. releases-scantraxx-march-2026)

Polite by design: this month's and next month's page only (2 requests a day, ≥ 4 s apart via
PoliteHttp), once a day from the daily hub-jobs run. Next month's page usually doesn't exist yet:
a 404 there is normal. Stored per release: artist, title, label, date, URL; nothing else.

VERIFIED against the real page (2026-11-07): one capture of
https://www.scantraxx.com/news/releases-scantraxx-october-2026 (HTTP 200), saved trimmed as
tests/fixtures/release_radar/scantraxx_live_october_2026.html. The page is NOT a list of
"Artist – Title" lines: every release is a card,

    div.trackItem → .artistsInfo  "Demi Kanon,Caelum"           (comma-separated credits)
                    a.trackLink   href="/releases/34666/paralyzed" (stable release id)
                    .innerLabel   "Paralyzed"                   (the title attribute is double-escaped; the text isn't)
                    .version      usually empty (an edit/mix name when present)
                    .trackLabel   "Scantraxx" | "Roughstate" | "This Is Hardstyle" | "SEVEN Records" …
                    .date         "02 / 10 / 2026"

so parse() reads those cards first (all 14 on the captured page). The earlier line-based reader
stays as a fallback for other layouts (the hand-written fixtures). The site lives on the www host
(scantraxx.com answers 301 → www). On by default; RADAR_SCANTRAXX=off turns the source off.

Base URL: RADAR_SCANTRAXX_BASE (default https://scantraxx.com); the E2E run points it at a mock.
"""
from __future__ import annotations

import os
import re
from datetime import date
from html.parser import HTMLParser
from urllib.parse import urljoin

from lib.release_radar.match import credit_matches
from lib.release_radar.model import RadarArtist, ReleaseItem, SourceResult

NAME = "scantraxx"
LABEL = "Scantraxx"
LABEL_NAME = "Scantraxx"
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
_MON = {m: i + 1 for i, m in enumerate(MONTHS)} | {m[:3]: i + 1 for i, m in enumerate(MONTHS)} | {"sept": 9}
GAP_SECONDS = 4.0
DISABLED_REASON = "turned off with RADAR_SCANTRAXX=off"
_CARD_FIELDS = ("artistsInfo", "innerLabel", "version", "trackLabel", "date")
_CARD_DATE = re.compile(r"(\d{1,2})\s*/\s*(\d{1,2})\s*/\s*(\d{4})")
_RELEASE_ID = re.compile(r"/releases/(\d+)(?:/|$)")


def enabled() -> bool:
    """On by default (verified against the real page, 2026-11-07); RADAR_SCANTRAXX=off turns it off."""
    return os.environ.get("RADAR_SCANTRAXX", "on").strip().lower() not in ("off", "0", "false", "no")

_BLOCK = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "dt", "dd", "div", "br", "tr", "section", "article", "blockquote", "figcaption"}
_SKIP = {"script", "style", "nav", "header", "footer", "form", "noscript", "svg", "button", "aside"}
_DASH = re.compile(r"\s+[–—-]\s+|\s[–—]\s?|\s?[–—]\s")
_CAT = re.compile(r"[\[\(]?\b(?:SCAN(?:TRAXX)?|SCANX|SCANPRO|SCANBLACK|SCANCARBON|HARDDRIVER|SCANTRAXX\s+RELOADED)\s*[- ]?\d{2,4}\b[\]\)]?", re.I)
_NOISE = re.compile(r"\b(out\s+now|pre-?save|presave|stream\s*/\s*download|listen\s+now|buy\s+now)\b[:!]?", re.I)
_DMY = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b")
_D_MON = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(sorted(_MON, key=len, reverse=True)) + r")\b\.?(?:\s+(\d{4}))?", re.I)
_MON_D = re.compile(r"\b(" + "|".join(sorted(_MON, key=len, reverse=True)) + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?", re.I)


def page_url(month: int, year: int) -> str:
    base = os.environ.get("RADAR_SCANTRAXX_BASE", "https://www.scantraxx.com").rstrip("/")
    return f"{base}/news/releases-scantraxx-{MONTHS[month - 1]}-{year}"


class _Text(HTMLParser):
    """Visible text of <article> (else <main>, else <body>) as lines, in document order."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.lines: dict[str, list[str]] = {"article": [], "main": [], "body": []}
        self.inside = {"article": 0, "main": 0}
        self.buf: list[str] = []

    def _flush(self):
        t = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        self.buf = []
        if t:
            for k, depth in self.inside.items():
                if depth:
                    self.lines[k].append(t)
            self.lines["body"].append(t)

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
        if tag in self.inside:
            self._flush()
            self.inside[tag] += 1
        if tag in _BLOCK:
            self._flush()

    def handle_endtag(self, tag):
        if tag in _BLOCK:
            self._flush()
        if tag in self.inside and self.inside[tag]:
            self._flush()
            self.inside[tag] -= 1
        if tag in _SKIP and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)

    def result(self) -> list[str]:
        self._flush()
        return self.lines["article"] or self.lines["main"] or self.lines["body"]


class _Cards(HTMLParser):
    """The release cards of the real monthly page (see the module docstring)."""

    _VOID = {"br", "img", "input", "meta", "link", "hr", "source", "path", "circle"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards: list[dict] = []
        self.stack: list[tuple[str, str | None]] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if "trackItem" in classes:
            self.cards.append({k: "" for k in _CARD_FIELDS} | {"href": ""})
        if self.cards and tag == "a" and "trackLink" in classes:
            self.cards[-1]["href"] = a.get("href") or ""
        if tag in self._VOID:
            return
        field = next((f for f in _CARD_FIELDS if f in classes), None)
        self.stack.append((tag, field))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not self.cards:
            return
        field = next((f for _, f in reversed(self.stack) if f), None)
        if field:
            self.cards[-1][field] += data


def parse_cards(html: str, page_url: str | None = None) -> list[dict]:
    p = _Cards()
    p.feed(html)
    out = []
    for c in p.cards:
        artist = re.sub(r"\s+", " ", c["artistsInfo"]).strip()
        title = re.sub(r"\s+", " ", c["innerLabel"]).strip()
        version = re.sub(r"\s+", " ", c["version"]).strip()
        m = _CARD_DATE.search(c["date"])
        if not (artist and title and m):
            continue
        if version and version.casefold() not in title.casefold():
            title = f"{title} ({version})"
        try:
            when = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            continue
        href = c["href"]
        rid = _RELEASE_ID.search(href)
        out.append({
            "artist": artist, "title": title, "date": when, "precision": "day",
            "label": re.sub(r"\s+", " ", c["trackLabel"]).strip() or LABEL_NAME,
            "url": urljoin(page_url or "https://www.scantraxx.com/", href) if href else page_url,
            "external_id": rid.group(1) if rid else None,
        })
    return out


def _date_in(line: str, month: int, year: int) -> date | None:
    def mk(y, m, d):
        try:
            return date(y, m, d)
        except ValueError:
            return None
    if m := _DMY.search(line):
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return mk(y + 2000 if y < 100 else y, mo, d)
    if m := _D_MON.search(line):
        return mk(int(m.group(3) or year), _MON[m.group(2).lower().rstrip(".")], int(m.group(1)))
    if m := _MON_D.search(line):
        return mk(int(m.group(3) or year), _MON[m.group(1).lower().rstrip(".")], int(m.group(2)))
    return None


def _clean(s: str) -> str:
    s = _NOISE.sub(" ", _CAT.sub(" ", s))
    s = re.sub(r"^[\s|•·:*\-–—]+|[\s|•·:*]+$", "", s)
    return re.sub(r"\s+", " ", s).strip(" \"“”'")


def parse(html: str, month: int, year: int, url: str | None = None) -> list[dict]:
    """Releases in page order: the real page's cards (parse_cards: + label, external_id), else the
    line-based fallback [{artist, title, date, precision, url}] where undated lines get the month."""
    cards = parse_cards(html, url)
    if cards:
        return cards
    lines = _Text()
    lines.feed(html)
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    current: date | None = None
    for raw in lines.result():
        if len(raw) > 160 or "http" in raw.lower():
            continue
        d = _date_in(raw, month, year)
        parts = _DASH.split(raw, maxsplit=1)
        if len(parts) == 2:
            # "Title | Pre-save now" / "Title | SCAN 412": the release is the first segment.
            artist, title = _clean(_DMY.sub(" ", parts[0]) if d else parts[0]), _clean(re.split(r"\s+\|\s+", parts[1])[0])
            # "06/03 | Artist – Title": the date sits in front of the artist.
            artist = _clean(_D_MON.sub(" ", artist)) if d and _D_MON.search(artist) else artist
            headline = artist.casefold().startswith(("release", "scantraxx", "posted", "©")) or title.casefold().startswith(("release", "scantraxx"))
            if artist and title and len(artist) <= 80 and len(title) <= 100 and not headline:
                key = (artist.casefold(), title.casefold())
                if key not in seen:
                    seen.add(key)
                    when = d or current
                    out.append({"artist": artist, "title": title, "date": when or date(year, month, 1),
                                "precision": "day" if when else "month", "url": url})
                continue
        if d is not None:
            current = d
    return out


def fetch(artists: list[RadarArtist], *, http, today: date) -> SourceResult:
    res = SourceResult(items=[])
    months = [(today.month, today.year), (today.month % 12 + 1, today.year + (1 if today.month == 12 else 0))]
    found = 0
    for i, (m, y) in enumerate(months):
        url = page_url(m, y)
        res.requests += 1
        try:
            r = http.get(url)
        except Exception as e:
            res.errors.append(f"{url}: {type(e).__name__}: {e}"[:200])
            if i == 0:
                res.fatal = res.errors[-1]
            continue
        if r.status_code == 404:
            if i == 0:
                res.fatal = f"{url}: HTTP 404 (this month's overview is missing; the page address may have changed)"
                res.errors.append(res.fatal)
            continue
        if r.status_code >= 400:
            res.errors.append(f"{url}: HTTP {r.status_code}")
            if i == 0:
                res.fatal = res.errors[-1]
            continue
        rows = parse(r.text, m, y, url)
        found += len(rows)
        for row in rows:
            match = next((a for a in artists if credit_matches(row["artist"], a.key)), None)
            if match is None:
                continue  # only artists you actually listen to (or follow in Rotor)
            ext = f"release:{row['external_id']}" if row.get("external_id") else f"{y}-{m:02d}:{row['artist'].casefold()}:{row['title'].casefold()}"
            res.items.append(ReleaseItem(
                source=NAME, external_id=ext[:300],
                artist_key=match.key, artist_name=row["artist"], artist_id=match.spotify_id, title=row["title"],
                release_date=row["date"], precision=row["precision"], url=row.get("url") or url, label=row.get("label") or LABEL_NAME,
            ))
    res.detail = {"pages": res.requests, "lines": found, "matched": len(res.items)}
    return res
