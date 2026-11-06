# Release radar fixtures (R7)

Saved responses the parsers and adapters are tested against. The test suite and the E2E run never
touch the network.

| File | What | Origin |
|---|---|---|
| `scantraxx_live_october_2026.html` | **The real page**: one capture of `https://www.scantraxx.com/news/releases-scantraxx-october-2026` (2026-11-07, HTTP 200), trimmed to the page title, the week headings and the 14 release cards' data elements (artists, title link, version, label, date) in their original markup | **Real capture, trimmed.** Images, audio previews, SVGs, scripts, navigation and the editorial text are removed. |
| `scantraxx_article.html` | Monthly overview as a news article: date headings, "Artist – Title" lines, catalogue numbers, nav/cookie/footer noise | **Hand-written** before the real page was seen; keeps the parser's line-based fallback tested. (The bare `scantraxx.com` answered `301` → `www.scantraxx.com`.) |
| `scantraxx_table.html` | The same information as a table (date cell + release cell), no `<article>` | Hand-written (fallback layout) |
| `mb_url_spotify.json` | `GET /ws/2/url?resource=https://open.spotify.com/artist/…&inc=artist-rels` | Hand-written in MusicBrainz's documented JSON shape |
| `mb_artist_search.json` | `GET /ws/2/artist?query=artist:"…"` (one exact match + a namesake) | Hand-written, documented shape |
| `mb_release_search.json` | `GET /ws/2/release?query=arid:… AND date:[…]` (two editions of one release group, a future single) | Hand-written, documented shape |
| `spotify_artist_albums.json` | `GET /v1/artists/{id}/albums` | Hand-written, Spotify's documented shape (same fields `lib/missed_new_tracks.py` reads) |

To check the parser against a newer page later (the site may change its markup), capture one page
(a single request, from your own machine) and add it here:

```bash
uv run python scripts/release_radar_capture.py scantraxx march 2026
```

then add a test case in `tests/test_release_radar.py` with the releases you see on that page.
