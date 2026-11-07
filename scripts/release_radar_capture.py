"""Save ONE label page as a release-radar test fixture (v0.87, R7). Run it yourself; the tests never do.

  uv run python scripts/release_radar_capture.py scantraxx march 2026

Fetches https://www.scantraxx.com/news/releases-scantraxx-march-2026 once (same polite client and
User-Agent as the daily radar), saves it to tests/fixtures/release_radar/scantraxx_live_<month>_<year>.html
and prints what the parser reads from it, so you can turn it into a test case.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.release_radar.http import PoliteHttp  # noqa: E402
from lib.release_radar.sources import scantraxx  # noqa: E402


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] != "scantraxx" or sys.argv[2].lower() not in scantraxx.MONTHS:
        print(__doc__)
        return 2
    month = scantraxx.MONTHS.index(sys.argv[2].lower()) + 1
    year = int(sys.argv[3])
    url = scantraxx.page_url(month, year)
    http = PoliteHttp()
    r = http.get(url)
    print(f"GET {url} → HTTP {r.status_code}, {len(r.text)} bytes")
    if r.status_code != 200:
        return 1
    out = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "release_radar" / f"scantraxx_live_{sys.argv[2].lower()}_{year}.html"
    out.write_text(r.text, encoding="utf-8")
    print(f"saved {out}")
    for row in scantraxx.parse(r.text, month, year, url):
        print(f"  {row['date']} ({row['precision']}) | {row['artist']} – {row['title']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
