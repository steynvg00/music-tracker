# 05 — Design system ("Spotify-inspired", Rotor-branded)

> Same layout conventions and feel as Spotify (dark, content-first, big artwork, tab bar / sidebar / player bar), with Rotor's own name, mark, type, icons and accent. The prototype (`prototype.html`) implements these tokens 1:1.

## 0. What "inspired, not copied" means concretely

| Keep (conventions) | Don't (identity) |
|---|---|
| Dark UI, artwork-led cards, bottom tab bar, mini-player, left library sidebar, bottom player bar, full-screen player sheet | Spotify Green, the Spotify logo/wordmark/icon as *your* brand, Circular / Spotify Mix typefaces, Spotify's icon set |
| Tap row = play, ⋯ = actions | Spotify's exact screen recipes ("Made for you" rows, "Jump back in" copy) |
| Shelves with horizontal scroll | Text or logos **on top of album artwork** (forbidden by Spotify's guidelines) |
| Artwork corner radius 4 px (small/medium) / 8 px (large), as Spotify's guidelines require | Cropping, blurring or animating album art |

Spotify attribution (when you decide to add it, open question 2): use the official logo files from Spotify's brand resources in the **attribution slot** component only. ≥ 70 px full logo, or ≥ 21 px icon where space is tight; monochrome on non-black/white backgrounds.

## 1. Brand

- **Name:** Rotor (placeholder). Wordmark: lowercase `rotor` in Manrope 800, −0.03 em tracking.
- **Mark:** a circle with three curved blades (a rotor / vinyl spin). It works at 16 px. The prototype draws it as inline SVG.
- **Voice:** short, direct, a bit of hardstyle energy in empty states ("Nothing playing. Drop the kick?"). Never cute in error states.

## 2. Colour tokens

### 2.1 Core (dark is the only theme; a light theme is out of scope)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0B0B0E` | App background |
| `--surface-1` | `#131317` | Sidebar, right panel, tab bar, player bar |
| `--surface-2` | `#1B1B21` | Cards, rows on hover, sheets |
| `--surface-3` | `#25252D` | Raised: hovered cards, inputs, chips |
| `--surface-4` | `#30303A` | Pressed, selected chips, scrubber track |
| `--border` | `#2C2C35` | Hairlines, dividers |
| `--text-1` | `#F5F5F7` | Primary text (18.0:1 on `--bg`) |
| `--text-2` | `#B4B4BF` | Secondary (9.6:1 on `--bg`, 8.3:1 on `--surface-2`) |
| `--text-3` | `#8E8E9A` | Tertiary / meta (6.1:1 on `--bg`, 5.3:1 on `--surface-2`, 4.7:1 on `--surface-3`). Lowest allowed for text |
| `--accent` | `#9D6BFF` | **Rotor Violet**: play buttons, active tab, progress fill, focus |
| `--accent-hover` | `#B18BFF` | Hover |
| `--accent-press` | `#8653F2` | Pressed |
| `--accent-subtle` | `rgba(157,107,255,.16)` | Selected chip bg, active row bg |
| `--on-accent` | `#140A2B` | Icons/text on accent (5.4:1; white would be only 3.5:1, so **dark** icons on the violet play button) |
| `--data-2` | `#3DD9EB` | Second data series (cyan) |
| `--data-3` | `#FFC24B` | Third series (amber) |
| `--success` | `#3CCFB0` | Done, synced (teal, kept away from Spotify green) |
| `--warning` | `#FFB547` | Token expiring, ingest lagging |
| `--danger` | `#FF5C7A` | Errors, destructive |
| `--info` | `#6CB8FF` | Neutral notices |

Why violet: Spotify green, YouTube red and SoundCloud orange all appear in the product *as source signals*. An accent from any of those families would blur "this is Rotor" with "this is that service".

### 2.2 Source signals (monochrome-first)

| Source | Badge | Tint (dot only) | Rule |
|---|---|---|---|
| Spotify | text "Spotify" + neutral disc glyph (prototype) → official icon in production if you opt in | none (neutral `--text-2`) | Attribution slot sits next to Spotify metadata in the player and detail headers |
| YouTube | rounded-rect ▷ glyph + "YouTube" | `#FF4E45` dot | Only inside Elsewhere |
| SoundCloud | cloud glyph + "SoundCloud" | `#FF8A3D` dot | Only inside Elsewhere |

Brand colours appear only as a 6 px dot, never as a fill. That keeps third-party trademarks at arm's length and the UI calm.

### 2.3 Ambient header colour

Detail headers (playlist, album, artist, full player) use a vertical gradient from the artwork's **dominant colour**, darkened to ≤ 35% lightness, to `--bg` over 320 px. The gradient uses the *extracted colour*. The artwork itself is never blurred or stretched (Spotify guideline: artwork untouched). Fallback: `--surface-2`.

## 3. Typography

Family: **Manrope** (Google Fonts, variable 400–800) for everything. Numbers use `font-variant-numeric: tabular-nums` wherever they change (durations, counts, stat tiles).

| Token | Mobile | Laptop | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `display` | 32/36 | 56/60 | 800 | −0.03 em | Playlist/artist header title |
| `title-1` | 24/28 | 32/36 | 800 | −0.02 em | Screen titles, Today's pick title |
| `title-2` | 20/24 | 24/28 | 700 | −0.01 em | Section headers ("On this day") |
| `title-3` | 16/20 | 16/20 | 700 | 0 | Card titles, track title in player |
| `body` | 15/20 | 14/20 | 500 | 0 | Rows, paragraphs |
| `body-strong` | 15/20 | 14/20 | 650 | 0 | Track title in rows |
| `caption` | 13/16 | 13/16 | 500 | 0 | Artist line, meta, chips |
| `micro` | 11/14 | 11/14 | 700 | +0.06 em, uppercase | Overlines, badges ("GENERATED") |
| `stat` | 28/32 | 32/36 | 800 | −0.02 em, tabular | Stat tile numbers |

Truncation: one line with ellipsis in rows and cards, two lines max for card titles. The **full title is always reachable** (`title` tooltip on laptop, detail page on mobile), as Spotify's metadata rule requires.

## 4. Spacing, layout, radii, elevation

- **Spacing scale (4-pt):** `2 4 8 12 16 20 24 32 40 48 64`.
- **Gutters:** mobile 16 px, laptop main view 24 px (32 px ≥ 1440 px).
- **Breakpoints:** `< 768` mobile (tab bar) · `768–1179` laptop two-column (sidebar + main; right panel as overlay) · `≥ 1180` three-column.
- **Safe areas:** `env(safe-area-inset-*)` on header (top), tab bar (bottom), full player (both) and sheets (bottom). Requires `viewport-fit=cover`.
- **Fixed heights:** tab bar 56 + inset · mini-player 60 · laptop player bar 80 · sidebar row 56 · track row 56 (mobile) / 48 (laptop table).

| Radius token | Value | Use |
|---|---|---|
| `--r-art-s` | 4 px | Artwork ≤ 64 px (rows, mini-player, sidebar) |
| `--r-art-l` | 8 px | Artwork > 64 px (cards, hero, full player) |
| `--r-card` | 8 px | Cards, tiles, inputs |
| `--r-sheet` | 16 px | Top corners of bottom sheets, dialogs |
| `--r-pill` | 999 px | Buttons, chips, segmented control, badges |

Elevation (dark UIs show depth through surface steps more than shadows): `--shadow-pop: 0 12px 32px rgba(0,0,0,.55)` for sheets, menus and the device picker. `--shadow-card-hover: 0 8px 24px rgba(0,0,0,.4)`.

## 5. Cover-art treatments

| Context | Size (mobile / laptop) | Radius | Treatment |
|---|---|---|---|
| Track row | 40 / 40 | 4 | — |
| Sidebar row | — / 48 | 4 (playlists) · circle (artists) | — |
| Mini-player | 40 | 4 | — |
| Player bar | — / 56 | 4 | — |
| Shortcut tile | 56 / 64 | 4 (left edge of tile) | — |
| Shelf card | 140 / 176 | 8 | Hover (laptop): card bg `--surface-3` + floating violet play button bottom-right of the card **body** (beside the art, never on it) |
| Hero (Today's pick) | 120 / 200 | 8 | Generated picks use a **Rotor cover** (below). Existing playlists use their Spotify cover untouched |
| Full player | min(84 vw, 360) / right panel 300 | 8 | Ambient gradient behind it |
| Artist | circle | 50% | Circle is a *frame*, not a crop of album art (artist images only) |

**Rotor covers (own artwork, so text is allowed):** for generated picks, custom playlists without art, and placeholders. A 2-stop gradient keyed to the recipe (Forgotten gems: violet → indigo; Fresh heat: magenta → amber; Evergreen: cyan → indigo; Deep dive: amber → rose), the rotor mark at 20% opacity, and the title in `title-2`, bottom-left, `--text-1`. Generated deterministically from the recipe ID, so the same recipe always looks the same.

**Missing art:** `--surface-3` square with a music-note glyph in `--text-3`.

## 6. Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `--t-micro` | 120 ms | `cubic-bezier(.2,0,0,1)` | Hover, press, chip toggle |
| `--t-std` | 200 ms | `cubic-bezier(.2,0,0,1)` | Row highlight, toast in, icon morph play ↔ pause |
| `--t-sheet` | 320 ms | `cubic-bezier(.3,0,0,1)` (emphasised) | Sheets, full player open |
| `--t-exit` | 180 ms | `cubic-bezier(.4,0,1,1)` | Anything leaving |
| `--t-rotate` | 450 ms | emphasised | Today's pick rotate: card slides out left + skeleton pulse + new card in |

- **Playing indicator:** 3 bars, 4 px wide, animated heights, in `--accent`, shown on the playing row, card and sidebar entry.
- **Optimistic feedback:** play/pause icon morphs immediately (`--t-std`). If the command fails, a 2-step shake (6 px, 160 ms) + toast.
- `prefers-reduced-motion: reduce` → crossfades only, no slides, no equaliser animation (static bars).

## 7. Components

States legend: **D** default · **H** hover (laptop) · **P** pressed · **F** focus-visible (2 px `--accent` ring, 2 px offset) · **A** active/selected · **▶** playing · **X** disabled · **L** loading (skeleton).

### 7.1 Navigation and shells

| Component | Anatomy | States | Mobile vs laptop |
|---|---|---|---|
| **Tab bar** | 4 items (icon 24 + label micro) | D, P, A (icon filled + `--text-1` label, others `--text-3`) | Mobile only. `--surface-1` @ 92% + backdrop blur, bottom inset padding |
| **Sidebar** | Brand row · Home/Search links · Library header (title, + New, collapse) · source switch · chips · scroll list | collapsed (72 px icons-only) / expanded (280 px) | Laptop only |
| **Header (mobile)** | greeting `title-1` · health dot · avatar 32 | sticky with fade-in `--bg` after 24 px scroll | Laptop: header lives inside the main view, plus back/forward buttons |
| **Right panel** | Now playing title · art 300 · title/artist · attribution slot · history card · badges · up next | hidden / open (340 px) | Laptop ≥ 1180 docked; 768–1179 overlay drawer |

### 7.2 Library and content

| Component | Anatomy | States | Mobile vs laptop |
|---|---|---|---|
| **Sidebar library row** | art 48 (r4) · name (`body-strong`, 1 line) · meta line (kind badge + "Playlist · 132 tracks") · optional lock glyph · playing bars | D, H (`--surface-2`), P, A (current route: `--surface-3`), ▶ (name in `--accent` + bars) | Laptop sidebar. Collapsed = art only + tooltip |
| **Library row (mobile)** | art 56 · name · meta · ⋯ | D, P, A, ▶ | Same component, 56 px art, full-width |
| **Shelf** | header (`title-2` + "Show all" caption link) · horizontal scroller (snap, 12 px gap) | L (3 skeleton cards) | Mobile: scroll. Laptop: grid that wraps to N columns, "Show all" when > 1 row |
| **Shelf card** | art 140/176 (r8) · title (2 lines) · subtitle (caption) · laptop-only floating play button | D, H (bg `--surface-3`, play button rises 8 px + fades in), P, F, ▶ (play button stays visible as pause), L | Mobile: no hover button; long-press = play |
| **Shortcut tile** | art 56 left (r4) · name (2 lines, body-strong) · bars when playing | D, H, P, ▶ | 2 × 3 grid on mobile, 4 × 2 on laptop |
| **Hero: Today's pick** | overline "TODAY'S PICK · 1 OF 5" · art · kind badge · title (`title-1`) · reason (`caption`) · primary Play (48) · secondary Rotate (pill, icon + label) · candidate dots | D, L (rotating), ▶ (Play → Pause, bars on art edge), X (no device: Play opens device picker, never disabled) | Mobile: stacked (art 120 left, text right, buttons below). Laptop: art 200 left, large title, ambient gradient |
| **Track row** | index or bars · art 40 · title (body-strong) + artist (caption, links) · [laptop: album, your plays, last played] · duration (tabular) · ⋯ | D, H, P, A (selected), ▶ (title `--accent`), X (unplayable: 40% opacity + "Not available" tooltip) | Laptop: table columns with sortable headers. Mobile: 2-line row |
| **Kind badge** | micro text in pill: `AUTO`, `SNAPSHOT`, `CUSTOM` (+ TTL "3 D"), `GENERATED`, `FROM LIBRARY` · or lock glyph for read-only | static | Same |
| **Chip** | label caption · optional leading icon · optional count | D (`--surface-3`), H, P, A (`--accent-subtle` bg + 1 px `--accent` border + `--text-1` label + ✓ in `--accent`; violet *text* on chips would be 4.3:1, under the bar), X | Filter chips scroll horizontally on mobile |
| **Segmented control (source switch)** | 3 segments: Spotify · YouTube · SoundCloud, each with source glyph | D, A (`--surface-4` thumb slides `--t-std`) | Full width on mobile, sidebar width on laptop |
| **Stat tile** | overline (micro) · number (`stat`) · delta chip (▲ 12% `--success` / ▼ `--danger` / — neutral) · optional sparkline (40 px, `--accent` stroke) | D, H, P (opens stats), L | Mobile: 148 × 112 in a scroller. Laptop: grid of 4–5 |
| **Badge chip (achievement)** | 40 px PNG from `assets/badges/` · name · date | earned (full colour), unearned (30% + grayscale) | Grid in detail pages |
| **Source badge** | glyph 12 + label micro, 6 px tint dot | static | Same |
| **Attribution slot** | "Spotify" label (prototype) / official logo (production, opt-in) + "Open in Spotify" text link | D, H, F | Player sheet, right panel, detail headers |

### 7.3 Playback

| Component | Anatomy | States | Mobile vs laptop |
|---|---|---|---|
| **Mini-player** | art 40 · title + artist (1 line each, marquee off) · device line (⌁ + device name, caption `--accent` when remote) · play/pause 40 · 2 px progress hairline at the bottom edge | D, P (whole bar → opens full player), ▶/paused, L (shimmer while first state loads), X (no state: hidden) | Mobile only, floats 8 px above the tab bar, r8, `--surface-2` tinted with the ambient colour at 30% |
| **Player bar** | left: art 56, title/artist, ♡ hidden (no library writes) · centre: shuffle, prev, **play (40, `--accent`, dark icon)**, next, repeat · scrubber with elapsed/remaining · right: device button (name when remote), queue toggle, volume (hidden if `!supports_volume`) | per control: D, H (`--text-1`), P, A (shuffle/repeat on: `--accent` + dot), X (disallowed: 30% + "Not allowed on this device" tooltip) · scrubber: D, H (thumb appears), dragging, X (informational only) | Laptop only, `--surface-1`, 80 px |
| **Full-screen player** | handle · "Playing from {context}" (caption, link) · art · title (`title-1`) + artist (link) · attribution slot · scrubber · transport (64 play) · device button + queue · **history card** ("142 plays · since 14 Mar 2021 · 3 badges" → track detail) | open/closing (`--t-sheet`, art scales from mini-player position), ▶/paused, X | Mobile sheet. Laptop: the right panel is the equivalent; no separate full-screen view |
| **Device picker** (sheet on mobile / popover anchored to the device button on laptop) | title "Play on" · current device (accent, bars) · list rows (icon by `type`: phone / computer / speaker / TV, name, "Spotify Connect" caption, volume if supported) · "This laptop" row (laptop, SDK) · footer: "Don't see your phone? **Open Spotify**" | row: D, H, P, A (current), L (transferring: spinner), X (`is_restricted`) | Same content, different container |
| **Scrubber** | 4 px track (`--surface-4`), fill `--accent`, thumb 12 px on hover/drag, time labels tabular | D, H, dragging, X | Mobile: thumb always visible in full player |

### 7.4 Feedback and overlays

| Component | Anatomy | States | Notes |
|---|---|---|---|
| **Bottom sheet** | handle 36 × 4 · title row (`title-3` + close) · content · sticky footer actions | peek / half / full detents, dragging | Laptop: becomes a centred dialog (max 560 px) or popover |
| **Toast** | icon · one line · optional action (text button) | in/out `--t-std`, 4 s auto-dismiss (errors 6 s) | Stacks above mini-player / player bar |
| **Banner** (persistent) | full-width, icon, message, 1–2 actions | warning (token expiring), danger (reconnect required), info (Elsewhere / experimental) | Top of main view |
| **Health dot** | 8 px circle in header | green (`--success`), amber (`--warning`), red (`--danger`), pulsing when checking | Tap → Data health sheet |
| **Skeletons** | `--surface-2` blocks with a 1.2 s shimmer (`--surface-3`) | — | Same shapes as the final content (hero, card, row, tile) |
| **Empty states** | rotor mark (64, `--text-3`) · one line · one action | — | e.g. "No custom playlists yet. **New custom playlist**" |
| **Buttons** | primary (pill, `--accent` bg, `--on-accent` text, 48/40/32 heights) · secondary (pill, `--surface-3`) · ghost (text) · icon (40 circle; 44 min hit area) | D, H, P, F, X, L (spinner replaces label) | Play FAB = primary icon button 48–64 |

## 8. Accessibility checklist

- Text contrast ≥ 4.5:1 (`--text-3` is the floor), icons and large text ≥ 3:1. Icons on the violet play button are **dark** (`--on-accent`).
- Hit targets ≥ 44 × 44 px (mini-player play, chips, tab items).
- `aria-live="polite"` region announces track changes ("Now playing Born To Lead by Radical Redemption on iPhone"), throttled to once per change.
- Focus order follows reading order; sheets trap focus; Esc closes on laptop.
- Never rely on source colour alone: badges carry text labels.
- Respect `prefers-reduced-motion` (§6).

## 9. Token export (CSS)

```css
:root {
  --bg:#0B0B0E; --surface-1:#131317; --surface-2:#1B1B21; --surface-3:#25252D; --surface-4:#30303A;
  --border:#2C2C35; --text-1:#F5F5F7; --text-2:#B4B4BF; --text-3:#8E8E9A;
  --accent:#9D6BFF; --accent-hover:#B18BFF; --accent-press:#8653F2; --accent-subtle:rgba(157,107,255,.16); --on-accent:#140A2B;
  --data-2:#3DD9EB; --data-3:#FFC24B; --success:#3CCFB0; --warning:#FFB547; --danger:#FF5C7A; --info:#6CB8FF;
  --src-youtube:#FF4E45; --src-soundcloud:#FF8A3D;
  --r-art-s:4px; --r-art-l:8px; --r-card:8px; --r-sheet:16px; --r-pill:999px;
  --t-micro:120ms; --t-std:200ms; --t-sheet:320ms; --t-exit:180ms; --t-rotate:450ms;
  --ease-std:cubic-bezier(.2,0,0,1); --ease-emph:cubic-bezier(.3,0,0,1); --ease-exit:cubic-bezier(.4,0,1,1);
  --shadow-pop:0 12px 32px rgba(0,0,0,.55);
  --font: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
}
```
