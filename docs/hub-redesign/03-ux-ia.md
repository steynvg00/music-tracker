# 03 — Information architecture + UX

> Working name of the app: **Rotor** (placeholder; it rotates your library back into your ears). It deliberately doesn't start with "Spot" (Spotify Developer Policy VI.2).
> Layout conventions follow Spotify (tab bar, mini-player, library sidebar, player bar) because they're the conventions your hands already know. Identity, colour, type and icons are Rotor's own (`05-design.md`).

## 1. Principles

1. **Remote first.** Rotor never needs to be the speaker. It controls whatever Spotify device is playing. On the laptop it *can* also be the speaker ("This laptop", Web Playback SDK).
2. **Your library, your rules.** Everything Rotor adds (daily pick, rotation, rules, stats, badges) is something Spotify doesn't do. That's the "independent value" Spotify's policy III.11 asks for. Rotor does **not** rebuild Spotify's catalogue browsing or its Home.
3. **Read and play by default.** Any playlist without a managed suffix (`· Auto 🤖🔄`, `· Auto 🤖📸`, `· Custom 🎧`) shows a lock glyph and has no edit affordances anywhere (hard rule 3).
4. **Separate rooms.** YouTube and SoundCloud live in their own space, **Elsewhere**, with their own player. They never appear in the same list, shelf or queue as Spotify content (Spotify policy III.5 and the "never seated next to content from similar services" guideline; `01-feasibility.md` §0.3–0.4).
5. **Names verbatim.** Track, album and playlist titles are shown exactly as Spotify returns them, suffix emoji included. Spotify's guidelines forbid rewriting metadata. Rotor *adds* a kind badge next to the name instead of stripping the suffix.
6. **Stats one tap away.** Every track, artist and album name is a door to its detail page with your history.

## 2. Structure

### 2.1 Mobile (< 768 px): bottom tabs + mini-player + player sheet

```
┌──────────────────────────────┐  ← safe-area top (status bar)
│ Header: greeting · health · ⚙ │
│                              │
│        Main view             │  ← scrolls; stack navigation per tab
│   (Home / Search / Library / │
│        Stats)                │
│                              │
├──────────────────────────────┤
│ ▢ Born To Lead · Radical R. ▶│  ← mini-player (64 px), progress hairline,
│   ⌁ iPhone                   │    device line; swipe up → full player
├──────────────────────────────┤
│ ⌂ Home  ⌕ Search  ▤ Library  ◔ Stats │  ← tab bar (56 px)
└──────────────────────────────┘  ← safe-area bottom (home indicator)
```

| Tab | Root screen | Pushes to |
|---|---|---|
| **Home** | Today's pick, shortcuts, stat tiles, shelves (§4) | Daily pick detail, playlist detail, stats detail, Elsewhere |
| **Search** | Search *your* history and library (tracks, artists, albums, your playlists). Not the Spotify catalogue | Track / Artist / Album detail, playlist detail |
| **Library** | Source switch **Spotify · YouTube · SoundCloud** + filter chips + rows (§3) | Playlist / collection detail, New custom playlist sheet, Rules |
| **Stats** | Overview with time-range chips (the ported tabs from `02-inventory.md` §B) | Top, Patterns, Year, Records, Behaviour, Badges, Compare |

- **Mini-player:** always visible when anything is known about playback (even paused). Tap → full-screen player sheet. Play/pause button on the right. The device line under the title ("⌁ iPhone", "⌁ This laptop", "⌁ Living room") is tappable → device picker.
- **Full-screen player sheet:** drag handle; cover (8 px radius, no overlays); title and artist (both links → detail); attribution slot ("Spotify" + Open-in-Spotify); progress (informational when `seeking` is disallowed); transport (shuffle · prev · play/pause · next · repeat); device button; queue button; **"Your history with this track"** card (plays, first play, badges): Rotor's signature element that Spotify doesn't have. Swipe down or tap the chevron to close.
- **Sheets** (bottom sheets with 3 detents: peek, half, full) for the device picker, track actions, custom playlist editor, filters, confirmations.

### 2.2 Laptop (≥ 768 px; three columns ≥ 1180 px)

```
┌─────────────┬──────────────────────────────────────┬──────────────┐
│ Rotor  ⌂ ⌕  │  Main view (same screens as mobile,  │  Right panel │
│─────────────│  wider: grid shelves, tables)        │  Now playing │
│ Library     │                                      │  · history   │
│ [Spotify|YT|SC]                                    │  · badges    │
│ chips…      │                                      │  · queue     │
│ ▢ Daily pick│                                      │  (or YouTube │
│ ▢ Top 30 …  │                                      │  player when │
│ ▢ My Monthly│                                      │  in Elsewhere)│
│   …         │                                      │              │
├─────────────┴──────────────────────────────────────┴──────────────┤
│ ▢ Born To Lead       ⤮  ⏮  ⏯  ⏭  ↻   1:12 ━━━━━○──── 3:48   ⌁ ☰ 🔊 │  ← player bar (80 px)
│   Radical Redemption                                 iPhone ▾      │
└───────────────────────────────────────────────────────────────────┘
```

- **Left sidebar (280 px, collapsible to 72 px icons):** Home and Search links, then the library (source switch, chips, compact rows). Rows: 48 px cover + name + kind badge + lock glyph if read-only. A pinned "Today's pick" row sits on top.
- **Main view:** Home shelves become grids (4–6 cards per row). Track lists become tables (#, title/artist, album, your plays, last played, duration).
- **Right panel (340 px, toggle with ☰):** Now playing with the history card, badges, "heard alongside", then Up next (`GET /me/player/queue`, read-only). In Elsewhere this panel *hosts the visible YouTube player* (≥ 480×270), which satisfies YouTube's no-hidden-player rule naturally.
- **Player bar:** now playing (left), transport + scrubber (centre), device picker, queue toggle and volume (right; volume hidden when the device doesn't support it).
- **Keyboard:** Space play/pause, ⇧← / ⇧→ previous/next, ⌘K search, L library focus, D device picker.

### 2.3 Shared navigation rules

- Back stack per tab (mobile) / browser history (laptop). Deep links: `/playlist/:id`, `/track/:uri`, `/artist/:id`, `/stats/:section`, `/daily/:date`.
- **Tap on a track row = play** (from that list's context) is the Spotify convention, kept. **⋯ / long-press / right-click** = actions sheet: Track stats, Artist, Album, Add to queue, Open in Spotify, (in Custom playlists) Remove from this playlist.
- In Stats lists, tap = open detail (you're browsing data, not a playlist). A small ▶ on each row plays it.

## 3. Library and where YouTube / SoundCloud live

Library has one **source switch** at the top: `Spotify · YouTube · SoundCloud`. It is **exclusive**: there is no "All" view, so Spotify and other services never share a list. The last choice is remembered.

**Spotify** (default):
- Filter chips: `Managed 🔄` · `Snapshots 📸` · `Custom 🎧` · `Yours` (own, unmanaged) · `Followed` · `Liked Songs`
- Sort: Recently played in Rotor · Rotation score · A–Z · Track count
- Groups for Managed (mirrors the 16 rule categories): Streams thresholds, Top N, Discovered, Released, Monthly #1, Forgotten favourites, Missed new tracks. Each group header links to its **Rule** card ("Alle tracks met minimaal N streams…", cadence, next refresh).
- Header actions: **+ New custom playlist**, **Rules**.

**YouTube** / **SoundCloud** (Elsewhere): collections you imported (playlists, sets, "likes" sets, single-item lists). Each collection detail plays inside Rotor's own visible player, with the source's badge. A "Last checked" date honours YouTube's 30-day refresh rule.

**Home** shows one quiet link card at the very bottom: "Elsewhere · 6 YouTube & SoundCloud collections →". It contains no YouTube/SoundCloud artwork or items, only a door to the separate space. Whether you want the non-compliant variant (Elsewhere shelves on Home) is open question 1 in `06-roadmap.md`.

## 4. Home screen, in order

| # | Section | Data shown | Tap target | Opens |
|---|---|---|---|---|
| 0 | **Header** | Greeting by time of day; health dot (green / amber / red from ingest freshness + token countdown); avatar | Health dot; avatar | Data health sheet; Settings |
| 1 | **Device strip** (only when something is known) | "Playing on iPhone" / "Paused on Living room" / "No active device" | Strip | Device picker sheet (§8) |
| 2 | **Today's pick** (hero) | Cover (generated picks: Rotor's own cover art with the title *on* it; existing playlists: their Spotify cover, *no overlay*), title, kind badge **Generated** / **From your library**, reason ("Not played in 214 days" · "47 tracks · 2 h 51 min"), candidate dots (1 of 5) | **Play** · **Rotate** · card body | Play: plays on current device (flow a). Rotate: next candidate (flow b). Body: Daily pick detail |
| 3 | **Shortcuts** grid (2 × 3 compact tiles) | Your six most-played-from-Rotor playlists (seeded with Top 30 last 30 days, Forgotten favourites, Missed new tracks · popular artists, My Monthly #1, Liked Songs, latest Custom) | Tile; long-press | Playlist detail; long-press = play now |
| 4 | **Stat tiles** (horizontal scroll) | This week's plays + Δ vs last week · Current streak (days) · Top artist this month · Hours this month · New artists this month | Tile | Stats screen scrolled to that metric |
| 5 | **Fresh** shelf (conditional) | New snapshot (≤ 7 days old), the two Missed new tracks playlists | Card | Playlist detail |
| 6 | **On this day** shelf | One card per past year: top track of this date, plays that day | Card | Stats › On this day (that year expanded), ▶ plays that day's tracks as a list |
| 7 | **Recent badges** shelf | Last 8 badges (icon, name, track/artist) | Badge | Track or Artist detail, badges section |
| 8 | **Your custom playlists** shelf | Custom 🎧 playlists with TTL chip ("deletes in 3 d"), plus a "+ New" card | Card; + New | Playlist detail; Custom playlist sheet (flow d) |
| 9 | **Coming back around** shelf | Next 6 existing playlists in rotation order, with "last suggested 41 d ago" | Card | Playlist detail (read-only) |
| 10 | **Elsewhere** link card | Count of YouTube/SoundCloud collections | Card | Library with the YouTube/SoundCloud source selected |

Loading: skeleton hero + skeleton shelves. Data comes from one `/api/home` payload (precomputed rows, < 100 ms target; see `04-architecture.md` §6).

## 5. Flows

### (a) Open app → see today's pick → play it on my current Spotify device

1. Open Rotor (PWA from Home Screen). Home renders from `/api/home`. In parallel the client asks `GET /me/player` once.
2. Device strip shows "Paused on iPhone" (last state).
3. Hero shows Today's pick: *Forgotten gems — 38 tracks you loved and dropped* · **Generated**.
4. Tap **Play**.
   - Generated pick: server rewrites `Daily pick · Auto 🤖🔄` with the pick's tracks (managed suffix, so the write is allowed), *then* plays it.
   - Existing playlist: no write.
   - Either way: `PUT /me/player/play {context_uri, device_id: iPhone}`.
5. Optimistic UI: the hero button turns into an equaliser animation, the mini-player shows track 1 with "⌁ iPhone", and a confirming poll lands within ~1 s.
6. If the iPhone isn't in the device list: go to §8.

### (b) Rotate the daily pick

1. Tap **Rotate** on the hero (or swipe the hero left).
2. The card flips to a skeleton for 300–600 ms (optimistic). The server marks the current candidate `skipped` and returns the next one from the 5 precomputed candidates: no Spotify call, no generation wait.
3. The new pick shows with its reason line. Dots advance (2 of 5).
4. After the 5th candidate the button becomes **Shuffle the deck**. That requests a regeneration (server enqueues a job; the GitHub Action takes ~1 min). The hero shows "Mixing new picks… usually a minute" with the previous candidate still playable. A Web Push / in-app toast says when they're ready.
5. Rotation history is recorded: a rotated-away existing playlist gets `last_suggested_on = today`, so it won't come straight back.

### (c) Control playback that started outside the app

1. You started *Top 30 last 30 days* in the Spotify app on the living-room speaker, then open Rotor.
2. First poll: `is_playing: true`, device "Living room", context `spotify:playlist:…`.
3. The mini-player and device strip show "Playing on Living room". The context resolves via the playlist mirror: "Playing from Top 30 last 30 days · Auto 🤖🔄" (tap → playlist).
4. Pause, skip, seek and volume act on that device (`device_id` explicit). Disallowed actions render disabled.
5. If you change something in the Spotify app meanwhile, the next poll (≤ 5 s, or the scheduled end-of-track poll) reconciles. Rotor never fights state it didn't set.
6. If the context isn't yours (an album, a followed playlist), the "Playing from" line still shows the name and cover, but the row has no edit actions.

### (d) Create or edit a custom playlist

**Create**
1. Library › **+ New custom playlist** (or Home › Your custom playlists › + New).
2. Sheet step 1, **Filters**, as chips: Artists (search-as-you-type over your artists), Release years (range), Discovered (range), Min plays, Liked only, Sort, Max tracks. A live count ("212 tracks match") updates per change (debounced; server SQL function).
3. Step 2, **Preview**: track list with your plays per track. Swipe-left / ⋯ → remove a track (removals are stored as `excluded_uris` so an edit can re-apply them).
4. Step 3, **Save**: name (the ` · Custom 🎧` suffix is shown as a fixed, non-editable tail) + lifetime **7 days · 30 days · Keep**.
5. **Create** → server: `POST /me/playlists`, `POST /playlists/{id}/items` (batches of 100), inserts `custom_playlists` with `filters_json`. Toast "Created · Open in Spotify". Lands on the new playlist's detail.

**Edit** (only for `· Custom 🎧`)
1. Playlist detail › **Edit**. The same sheet opens, prefilled from `filters_json` + `excluded_uris`.
2. Change filters or remove tracks → **Update on Spotify** replaces the items (`PUT /playlists/{id}/items`).
3. Lifetime chip: Extend +7 d / Keep / Delete now (confirm sheet: "Deletes the playlist from your Spotify library").

### (e) Drill into stats for a track or artist

1. From anywhere: tap the title in the player sheet, ⋯ › Track stats on a row, or a Search result.
2. **Track detail**: header (cover, title, artists as links, Open in Spotify) · big numbers (plays, first play, last play, skip rate, completion) · plays-per-month sparkline · badges grid (earned bright, unearned dim, as in `_badge_display.py`) · "Usually heard alongside" (5 tracks) · URI variants under the same recording (ISRC canonical) · "In your playlists" (which managed playlists contain it, and why).
3. Tap an artist → **Artist detail**: plays, distinct tracks, years active in your history, artist badges, top tracks (▶ play as list), timeline, "Compare with…" (the old Artist battle).
4. Every list there can be played or saved as a Custom playlist.

### (f) Play a mixed playlist, and what the user sees when a handoff fails

> Policy status: 🔴 (Spotify III.5/III.7, `01-feasibility.md` §6.1). This flow describes the optional, laptop-first experimental feature (Release 5) so the decision can be made concretely. It is off by default.

1. Settings › Experimental › "Mixed sessions (conflicts with Spotify's developer policy)" → on, per device.
2. Elsewhere › a **Mix** (a separate list type; Spotify items show only as text + source badge, never inside Spotify lists) › **Start session**.
3. Preconditions check:
   - Spotify device must be **This laptop** (SDK) or the Spotify app on the same machine. Otherwise: "Spotify is playing on Living room. YouTube would play here, so the music would jump rooms." Options: **Move Spotify here** · **Skip YouTube items** · **Cancel**.
4. During the session the player bar shows a **source strip** (segments coloured by source) and the next handoff: "Next: YouTube · in 1:12".
5. Handoff states the user can see:
   - ✅ Normal: brief "Switching to YouTube…" (≤ 2 s), the YouTube player slides into the right panel.
   - ⏸ **Autoplay blocked** (iOS, sometimes desktop): full-width card "Tap to continue on YouTube" with the video's thumbnail. Spotify stays stopped.
   - ⏭ **Can't play here**: toast "Skipped 'Title' — the uploader doesn't allow embedding" and the conductor moves on.
   - 🔀 **Diverged**: banner "Mix paused — you're playing something else in Spotify" · **Resume mix** · **End session**.
   - 📻 **Spotify kept going** (device Autoplay): Rotor pauses Spotify within one poll and shows "Spotify autoplay was on for this device. Turn it off in Spotify › Settings › Playback for smoother mixes".
   - 📵 **iPhone locked**: Relay mode. Push notification "Spotify part finished — tap to continue on YouTube". Opening it shows the tap card.
6. Session end: summary with each handoff's gap (from `handoff_events`), so you can judge the experiment.

## 6. Daily pick detail

- Header: cover, title, kind badge, reason line, "Generated with recipe *Forgotten gems*", or for existing playlists "From your library · last played via Rotor 63 days ago".
- **Play** · **Rotate** · Open in Spotify.
- Track list (generated: full list; existing owned playlist: full list; followed playlist: "Track list isn't available for playlists you don't own. Play it to hear it" + Play).
- "Other candidates today": the remaining 4, tap to make one the current pick.
- History: the last 14 days' picks (played / rotated away).

## 7. Settings (short)

Connections (Spotify: authorized on, expires on, **Reconnect**; YouTube API key status; SoundCloud n/a) · Data health (ingest freshness, last cron runs, keepalive countdown, phantom plays) · Devices (default device, Autoplay hint) · Experimental (mixed sessions) · About.

## 8. When no Spotify device is active

| Situation | Detection | What the user sees | Actions |
|---|---|---|---|
| Devices exist, none active | `GET /me/player` → `204`; `GET /me/player/devices` returns ≥ 1 | Device strip: "Nothing playing". Pressing Play opens the **device picker** sheet first | Pick a device → `PUT /me/player/play {device_id}` (no separate transfer call needed) |
| No devices at all (Spotify apps asleep) | devices `[]` | Card: "Spotify isn't open anywhere" | **Open Spotify on this phone** (deep link `spotify:`; Rotor keeps the *pending play intent* and polls devices every 1 s for 12 s, then plays automatically) · **Play on this laptop** (SDK, laptop only) · **Try again** |
| Device just disappeared mid-session | active device missing from list | Mini-player: "Lost connection to iPhone" | **Reconnect** (same wake flow) · pick another device |
| Device is restricted (`is_restricted`) | devices list flag | Device shown greyed: "Spotify doesn't allow remote control of this device" | — |
| Token expired / Premium lapsed | `400 invalid_grant` / `403` | Full-width banner "Reconnect Spotify" (token) or "Spotify Premium is required" | **Reconnect** → OAuth → back where you were |
| Quota exceeded | `429 QUOTA_EXCEEDED` | Amber pill "Spotify is rate-limiting Rotor — updates slowed" | none (automatic back-off) |

The pending-intent pattern is the key detail: the user expresses *what* to play once, and Rotor finishes it as soon as a device appears. They never tap Play twice.
