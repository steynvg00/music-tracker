# 01 — Feasibility study

> Part of the hub redesign analysis (`docs/hub-redesign/`). Analysis and design only: no production code changes.
> Docs read on **2026-11-03**. No Spotify player or write endpoints were called and no scripts were run. Database access was read-only (`SELECT` / `EXPLAIN ANALYZE`, `statement_timeout = 15s`).
> Verdicts: 🟢 works as intended · 🟡 works with real limits or needs a spike test · 🔴 blocked by platform policy or technology.

## Verdicts at a glance

| # | Capability | Verdict | One line |
|---|---|---|---|
| 1 | Spotify remote control (Web API player) | 🟢 | Every control you asked for exists, needs Premium (you have it) and was not on the Feb 2026 removal list. |
| 1b | "Now playing" updates | 🟡 | No push channel. Polling only, against an undocumented quota that is now **shared with the crons**. |
| 2 | Web Playback SDK (app *is* the speaker) | 🟢 desktop / 🟡 iOS | Solid in desktop Chrome/Edge/Safari/Firefox. iOS needs a tap to start and is unproven when locked. Unsupported in Electron/Tauri. |
| 3 | Daily pick incl. existing playlists (read + play) | 🟢 own / 🟡 followed / 🔴 Spotify-made | Your own playlists can be read and played. Followed ones can be played but their tracks can't be read. Spotify-owned "Made for you" playlists can't be read and playing them is unverified. |
| 4 | YouTube (IFrame player + Data API) | 🟡 | Playback must stay visible (≥200×200) with no background or audio-only mode. Importing playlists is cheap (1 quota unit per 50 items). |
| 5 | SoundCloud | 🔴 API / 🟢 widget | Registering a new app requires Artist Pro. The widget and oEmbed work without a key for public and secret-link URLs. |
| 6 | Mixed playlists (Spotify + YT/SC in one queue) | 🔴 policy · 🟡 laptop · 🔴 iOS | Spotify's Developer Policy forbids it outright. Technically: workable on a foreground laptop tab, not on a locked iPhone. |
| 7 | iOS PWA (standalone, lock screen, background) | 🟡 | Fine as a *remote*: Spotify keeps playing in its own app. Weak as a *player*: JavaScript is suspended in the background. |
| 8 | Laptop shell (PWA / Tauri / Electron) | 🟢 PWA · 🟡 Tauri · 🔴 Electron | An installed PWA gets the Web Playback SDK. Tauri adds global media keys and a tray but loses the SDK. Electron can't get a Spotify Widevine licence. |

The rest of this document gives the evidence for each row. Section 0 comes first because three platform rules decide more of the design than any single API.

---

## 0. Platform rules that shape everything

### 0.1 Spotify Development Mode, 2026 edition

The app runs in **Development Mode** and will stay there: Extended Quota is open only to organisations with ≥250k MAU ([quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)). What that means now:

| Rule | Source | Impact on the hub |
|---|---|---|
| The app owner must have **Premium**, or the app stops working | [Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) | You have Premium. If it lapses, the hub *and* every cron stop. |
| Max **5 users**, each allowlisted | [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) | Single-user app, no issue. Doubles as a second auth gate. |
| Up to **25 Client IDs** per developer account (since July 2026) | [July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates) | A separate hub Client ID is *possible*, but see the next row. |
| **Quota is counted per developer account**, not per Client ID; a 429 now carries `"reason": "QUOTA_EXCEEDED"` | [July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates) | The hub's polling and the crons draw on **one pool**. A second Client ID does not isolate them. No numbers are published. |
| Endpoint removals apply to *new* Client IDs (from 11 Feb 2026). For existing integrations they are **postponed** and no new date has been given | [Feb 2026 blog](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security) | Your current Client ID still behaves like an *existing* app. `track_metadata` still gets `popularity` filled for October 2026 rows, which the new rules would have removed. A **new** Client ID would get the restricted set immediately. |
| Removed for restricted apps: batch `GET /tracks|albums|artists`, `GET /artists/{id}/top-tracks`, `/browse/new-releases`, `/browse/categories`, `GET /users/{id}/playlists`, `POST /users/{id}/playlists` (→ `POST /me/playlists`), `/playlists/{id}/tracks` (→ `/items`), per-type library endpoints (→ `/me/library`). Search `limit` capped at 10. Playlist `items` are **returned only for playlists you own or collaborate on** | [Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) | **No player endpoint is on the list.** The hub is designed against the *restricted* set anyway, so a future enforcement date doesn't break it. |
| Since Nov 2024, new or development-mode apps get no access to audio features, recommendations, related artists, featured or category playlists, or algorithmic and Spotify-owned editorial playlists | [Nov 2024 changes](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api) | Daily-pick generation must rely on *your own* data (it already does), not on Spotify recommendations. |

**Decision:** keep using the **existing Client ID** for the hub and add a redirect URI and player scopes. Creating a new one would move the hub onto the restricted endpoint set for no gain, because quota is shared per account anyway.

### 0.2 Refresh tokens now expire after 6 months

[Introducing refresh token expiration](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration) (18 Jun 2026; existing apps from **20 Jul 2026**):

- Lifetime is **6 months from the user's original authorization**. "Refreshing an access token does not reset or extend" it.
- Expired tokens return `400 invalid_grant`. Don't retry; send the user through sign-in again.
- Refresh tokens carry no issue date. Spotify tells you to "store the authorization date in your own database".

**Consequence for the current repo:** the cron's `SPOTIFY_REFRESH_TOKEN` lives in GitHub secrets. The last scope change (`user-follow-read`, commit `de1e01a`) is dated **2026-05-21**, the same day as the local `.env`. If that is when the secret was minted, every Spotify cron starts failing around **2026-11-21**, 18 days from now. Crons are still green today (`gh run list`). The hub design turns this into a first-class feature: token store + authorization date + countdown + one-tap reconnect (see `04-architecture.md` §3).

### 0.3 Spotify Developer Policy: the clauses that bite

From the [Spotify Developer Policy](https://developer.spotify.com/policy):

| Clause | Text (short quote) | What it means here |
|---|---|---|
| **III.5** | "Do not create any product or service which is integrated with streams or content from another service." | Showing YouTube/SoundCloud **inside the same product** as Spotify playback is on the wrong side of this clause. Mixed playlists are squarely on the wrong side. |
| **III.7** | Do not "segue, mix, re-mix, or overlap any Spotify Content with any other audio content" | A cross-source queue that hands off Spotify → YouTube is a segue. Crossfading across sources is excluded outright. |
| **III.11** | Don't "mimic, or replicate or attempt to replace a core user experience of Spotify"; must "add independent value" | "Looks and feels like Spotify" is a risk. The defence is independent value (rotation, rules, stats, managed playlists) and not cloning Spotify's identity or catalogue browsing. |
| **II.4.1 / II.4.2** | Attribute content as supplied by Spotify; metadata and cover art need "a link back" | Every Spotify track, album and playlist gets an "Open in Spotify" link. |
| **II.5** | "no playback of Spotify Content without showing relevant cover art and metadata" | The player bar always shows cover + title + artist. |
| **III.13 / III.14** | Don't analyse Spotify Content; don't train ML/AI on it | Your stats come from *your own* streaming-history export (personal data) and your own listening log. Keep it that way: no audio analysis, no model training. |
| **IV.2** | No commercial use of streaming apps | Personal use only. Never monetise or publish the hub. |
| **VI.2** | Name must not "begin with 'Spot'" or be confusable with Spotify | The placeholder name **Rotor** is fine. |

**Realistic risk reading:** Spotify enforces through the Client ID and the developer account. For a 1-user Development Mode app the chance of an audit is low, but not zero. The **cost** of enforcement is high: one revoked account kills the hub *and* the ~200 managed playlists the crons maintain. That asymmetry is why this study ranks YouTube/SoundCloud integration and mixed playlists as optional, late and opt-in.

### 0.4 Spotify Design Guidelines, concretely

From [Design & branding guidelines](https://developer.spotify.com/documentation/design):

1. **Attribution:** "you must always attribute content from Spotify with the logo". Full logo ≥70 px (icon-only ≥21 px when space is tight). Green logo only on black or white, otherwise monochrome. **Conflicts with your "no Spotify logo" rule.** The design keeps an *attribution slot* (a component that shows a neutral "Spotify" text label in the prototype). Whether to drop in the official logo file from Spotify's brand resources is open question 2 in `06-roadmap.md`. That is *licensed use*, not copying assets into your own branding.
2. **Metadata:** shown exactly as Spotify provides it, truncation allowed, full text reachable (tooltip or detail view), never rewritten. Your `track_name`/`artist_name` come from Spotify, so cleaning titles (e.g. stripping "- Radio Edit") is not allowed in Spotify contexts.
3. **Artwork:** no cropping, no distortion or animation, **no text or logos on top**, corners rounded **4 px** (small/medium screens) / **8 px** (large). Spotify-style "title over cover" tiles are **only** allowed on *your own* generated covers (managed playlists you uploaded art for), never on album art.
4. **Linking back:** "OPEN SPOTIFY" / "PLAY ON SPOTIFY" / "LISTEN ON SPOTIFY" (or "GET SPOTIFY FREE" when not installed).
5. **Playback controls:** recommended to limit to play/pause. Restricted controls need a disabled state. The progress bar must read as informational when seeking isn't allowed. For Premium + Web API you *can* skip and seek. The hub honours the `actions` / `disallows` flags from the playback state to disable controls.
6. **Colours:** don't use Spotify Green as your own brand. The hub accent is Rotor Violet `#9D6BFF`, chosen to stay clear of Spotify green, YouTube red and SoundCloud orange (see `05-design.md`).
7. **Naming / imitation:** no "Spotify" in the name, a logo not resembling Spotify's, "for Spotify" phrasing allowed.
8. **"Spotify content should never be seated next to content from similar services."** This is the clause that collides most directly with the vision: a YouTube shelf next to a Spotify shelf on Home is exactly that. The compliant layout puts YouTube/SoundCloud in a **separate space** ("Elsewhere") with its own player (see `03-ux-ia.md` §3).

---

## 1. Spotify remote control via the Web API player

### 1.1 Endpoint map

All player endpoints state "This API only works for users who have Spotify Premium" and "The order of execution is not guaranteed when you use this API with other Player API endpoints" ([Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback), [Add to queue](https://developer.spotify.com/documentation/web-api/reference/add-to-queue)).

| Need | Endpoint | Scope | Notes |
|---|---|---|---|
| Now-playing state (device, item, progress, shuffle, repeat, `actions`) | `GET /me/player` | `user-read-playback-state` | `204` with an empty body when nothing is active. |
| Lightweight now-playing | `GET /me/player/currently-playing` | `user-read-currently-playing` | No device block, so `GET /me/player` is preferred. |
| Device list | `GET /me/player/devices` | `user-read-playback-state` | Includes `is_active`, `supports_volume`, `type`. |
| Transfer playback | `PUT /me/player` `{device_ids:[id], play}` | `user-modify-playback-state` | One device ID only. |
| Play a context (playlist/album/artist) | `PUT /me/player/play` `{context_uri, offset, position_ms}` | `user-modify-playback-state` | Optional `?device_id=`; otherwise the active device. |
| Play a list of tracks | `PUT /me/player/play` `{uris:[...]}` | same | No documented max; keep lists modest. Playback **stops after the last URI** unless the device's Autoplay setting kicks in (see 1.5). |
| Pause / resume | `PUT /me/player/pause`, `PUT /me/player/play` | same | |
| Next / previous | `POST /me/player/next`, `POST /me/player/previous` | same | |
| Seek | `PUT /me/player/seek?position_ms=` | same | |
| Volume | `PUT /me/player/volume?volume_percent=` | same | Many phones report `supports_volume: false`, so hide the slider there. |
| Shuffle / repeat | `PUT /me/player/shuffle?state=`, `PUT /me/player/repeat?state=` | same | |
| Add to queue | `POST /me/player/queue?uri=` | same | Tracks or episodes. **No remove or clear endpoint exists**: the queue is append-only from the API's point of view. |
| Read queue | `GET /me/player/queue` | `user-read-currently-playing`, `user-read-playback-state` | |
| Recently played | `GET /me/player/recently-played` | `user-read-recently-played` | Already used by the */30 ingest. |

**Scopes to add** to the current set (`playlist-modify-public playlist-modify-private playlist-read-private user-library-read user-top-read user-read-recently-played user-follow-read`): `user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-collaborative`, plus `streaming user-read-email user-read-private` for the Web Playback SDK. Adding scopes means **re-consenting**, which creates a new refresh token and restarts the 6-month clock. Combine this with fixing §0.2.

### 1.2 Premium, Development Mode, rate limits

- Premium: required and present. The mobile-only Premium tiers are excluded from the SDK ([Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)), but not from Web API remote control.
- Rate limit: a "rolling 30 second window" with `429` + `Retry-After`. No numbers are published ([rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)).
- Quota: separate from rate limits, per developer account, no numbers ([July 2026](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)). The crons already spend part of it: */30 recently-played, the nightly sync/enrichment, Monday's ~200-playlist rewrite.
- Development Mode does not restrict player endpoints (they're absent from the removal list).

### 1.3 Latency

**Not measured.** Hard rule 2 forbids player calls in this run. Expectations from the architecture of Spotify Connect, to be confirmed by the Release 1 spike (`06-roadmap.md`):

| Path | Expected | Why |
|---|---|---|
| Browser → `api.spotify.com` (EU) → `204` | ~100–300 ms | One HTTPS round trip. |
| Command → audible change on a Connect device | ~0.3–1.5 s | Spotify cloud → device push → buffer. |
| Command → visible in `GET /me/player` | ~0.3–2 s | State propagates after the device acknowledges. "Order of execution is not guaranteed" means a poll right after a command can return the *old* state. |

**Design consequence:** optimistic UI. Flip the play/pause icon immediately, confirm with polls at +300 ms and +1200 ms, and roll back only if two confirms disagree.

### 1.4 Getting "now playing" updates

The Web API has **no webhook, SSE or WebSocket**. The private "dealer" WebSocket that open.spotify.com uses is undocumented, and using it would breach the Developer Terms. Excluded. The options:

| Option | Where | Verdict |
|---|---|---|
| Adaptive polling of `GET /me/player` | any device | 🟢 the default (strategy below) |
| Web Playback SDK `player_state_changed` events | only when the hub tab *is* the playback device | 🟢 zero polling while "This laptop" plays |
| [Spotify Soloist](https://developer.spotify.com/documentation/soloist/concepts/overview) WebSocket (`track_changed`, `position_sync`, `queue_changed` …) | only when Soloist (official headless Connect client, Linux / Apple Silicon Mac / Windows) is the device | 🟡 interesting for a home speaker on a Raspberry Pi. Builds expire every 90 days, the WebSocket has no auth or TLS, and a browser on https talking to `ws://127.0.0.1` runs into Local Network Access prompts. Not in the plan. |

**Polling strategy** (budget per open, visible client):

| State | Interval | Requests/min |
|---|---|---|
| Visible + playing | every 5 s, **plus** one poll scheduled at `duration − progress + 400 ms` (catches the track change exactly) | ~13 |
| Visible + paused / nothing playing | every 15 s | 4 |
| Right after a command | +300 ms, +1200 ms | +2 per command |
| Hidden tab / app backgrounded | **stop**; poll once on `visibilitychange`/`focus` | 0 |
| `429` (any reason) | honour `Retry-After`. On `QUOTA_EXCEEDED`, drop to 30 s and show a banner | — |

Progress between polls is interpolated locally (`progress_ms + (now − fetched_at)` while `is_playing`). A 3-hour listening session with the app open costs about 2,300 requests, of the same order as one Monday playlist refresh. The app is open far less than that, and polling stops in the background.

### 1.5 Behaviours that become UX requirements

1. **Phones fall off the device list.** An iPhone's Spotify app stops being listed after it has been idle or backgrounded for a while (widely reported community behaviour; to verify in the spike). Remedy: a "Wake Spotify" step that deep-links `spotify:` to open the app, then polls devices for ~10 s and transfers.
2. **`204` / `NO_ACTIVE_DEVICE`.** Commands without `device_id` fail when nothing is active. The hub always passes an explicit `device_id` from the picker (or from the last-used device).
3. **Order not guaranteed.** Never fire `play` then `queue` then `seek` in a burst. Serialise commands per client with a small queue and await each `204`.
4. **Queue is append-only.** The hub never treats Spotify's queue as its own. "Play this playlist" = `PUT /me/player/play {context_uri}`, which replaces the context. Items the *user* queued manually in the Spotify app stay ahead of it; the hub can show them (`GET /me/player/queue`) but can't remove them.
5. **Autoplay.** After a `uris` list ends, a device with "Autoplay similar content" on starts Spotify radio. Fine for the hub (Spotify keeps playing), a failure mode for the conductor (§6).
6. **Restrictions.** The playback state's `actions` object disables controls (e.g. no skipping during an ad on Free, or no seeking on some contexts). Controls render disabled, as the Design Guidelines require.
7. **Volume.** Show the slider only when `device.supports_volume`.

### 1.6 Verdict

🟢 **Remote control is feasible and is the strongest part of the vision.** 🟡 for now-playing because of polling against an unknown shared quota. Mitigate with adaptive polling, stopping in the background, and a measured budget in Release 1.

---

## 2. Spotify Web Playback SDK: when the app itself is the speaker

The SDK is "a client-side only JavaScript library" that creates a Spotify Connect device in the browser ([Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)). It requires Premium, excludes mobile-only Premium, and per Spotify's docs is supported in "Chrome, Firefox, Safari and Microsoft Edge" on "mobile (Android and iOS) and Desktop". The iOS caveat, from the troubleshooting page: "The playback does not start automatically after transfering playback. The user must interact with the SDK events to play audio." The terms add: "must not be used in commercial projects without Spotify's prior written approval".

| Surface | Works? | Detail |
|---|---|---|
| Laptop: Chrome/Edge (tab or installed PWA) | 🟢 | Widevine EME. The installed PWA keeps playing in the background, and tabs playing audio are exempt from intensive timer throttling. The SDK's events replace polling. |
| Laptop: Safari | 🟢 (supported per docs) | FairPlay path. Test once. |
| Laptop: Tauri (WKWebView) / Electron | 🔴 | Spotify staff: the SDK is designed for supported browsers, "not Electron". Electron/castlabs builds reportedly fail at the `widevine-license` step (500). Tauri's WKWebView is not Safari and is unverified at best ([community thread](https://community.spotify.com/t5/Spotify-for-Developers/WebSDK-500-error-on-license-endpoint-after-successful-device/m-p/6975176/highlight/true)). |
| iPhone PWA (standalone) | 🟡 | Officially supported with the tap requirement. Locked-screen continuity is **unproven**: WebKit has open bugs around standalone audio sessions ending after a track (bug 261858) and an iOS 26 regression where `audio.play()` resolves silently (bug 295518), both reported in community write-ups and unverified here. A JS-driven player also loses its next-track logic once iOS suspends the page. |

**Recommendation:** on the laptop, "This laptop" is a first-class device in the picker (SDK, from Release 1). On the iPhone the hub is **remote only**: the Spotify app stays the speaker, it gets proper lock-screen controls, CarPlay and AirPlay for free, and it never stops when the PWA is suspended. That's simply the better player on iOS.

---

## 3. Daily playlist rotation, including existing playlists (read + play only)

### 3.1 What exists today

There is **no daily-pick feature yet**. Related pieces: ~200 managed playlists (`lib/playlists.py`), `track_popularity_scores` (sticky / evergreen / flash-hit / session-loop), `artist_popularity_scores`, Forgotten favourites (≥50 streams, not heard in 730 days), Missed new tracks, liked songs, discovery and release years. These are all good recipe ingredients that need no Spotify recommendation endpoints (which are gone, §0.1).

### 3.2 Two kinds of daily pick

| Kind | Source of tracks | How it plays | Edit rights |
|---|---|---|---|
| **Generated** | Python recipe over your DB (e.g. *Forgotten gems*, *Evergreen core*, *Fresh heat*, *One-artist deep dive*, *Discovered in 2021*) | The hub writes the tracks into **one** managed playlist `Daily pick · Auto 🤖🔄` and plays it with `context_uri` | Allowed: managed suffix |
| **Existing playlist** | One of your Spotify playlists, picked by rotation | `PUT /me/player/play {context_uri: spotify:playlist:…}`, nothing written | **Read + play only.** Hard rule 3 is enforced in code (`04-architecture.md` §3.4). |

Why a managed playlist instead of a bare `uris` list: it gives a stable context (Spotify shows "Playing from Daily pick", shuffle and repeat behave normally, and it survives device transfers), and you can open it in Spotify. The playlist is rewritten **only when you press Play** on a new pick, so rotating through candidates costs zero Spotify calls.

### 3.3 Existing-playlist rotation: what the API allows

| Playlist type | Metadata (name, cover, owner, track count) | Track list | Play via `context_uri` | Rotation use |
|---|---|---|---|---|
| Owned by you, unmanaged ("old playlists") | 🟢 `GET /me/playlists` | 🟢 `GET /playlists/{id}/items` | 🟢 | Full: can show the tracks and compute "how much of this have I heard lately" |
| Collaborative | 🟢 | 🟢 (needs `playlist-read-collaborative`) | 🟢 | Full |
| Followed, owned by someone else | 🟢 | 🔴 "`items` is absent" for non-owned playlists ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)) under the restricted rules | 🟢 (player takes any context) | Play-only card: shows cover/name, no track preview |
| Spotify-owned editorial / algorithmic (Discover Weekly, Daily Mix …) | 🔴 not accessible to development-mode apps since Nov 2024 | 🔴 | 🟡 **unverified**: the player docs only say valid contexts are albums, artists and playlists | Excluded from rotation until the spike proves playback works |

**Rotation fairness without playlist-context history:** `spotify_plays` has no context column (the export and the ingest don't store which playlist a play came from). So "when did I last listen to this playlist" isn't in the data. The design uses two signals:

1. `playlist_rotation_history`, written by the hub whenever it suggests or plays a playlist (exact from day one).
2. For owned playlists: **coverage**, the share of the playlist's tracks you've played in the last 60 days, computed from `spotify_plays` against a nightly snapshot of the playlist's items. Low coverage plus a long time since last suggested means a high rotation score.

Score sketch: `score = w1·days_since_suggested + w2·(1 − coverage_60d) + w3·affinity − w4·skip_rate`, where `affinity` is the mean popularity percentile of the tracks you know. Generated in Python nightly with the rest of the candidates (`04-architecture.md` §4).

### 3.4 Verdict

🟢 for generated picks and owned playlists, 🟡 for followed playlists (play-only), 🔴 for Spotify-made playlists. The whole feature fits Development Mode as long as the managed-playlist write happens only on the `Daily pick` playlist.

---

## 4. YouTube

### 4.1 Playback: IFrame Player API

- Methods `loadPlaylist` / `cuePlaylist`, events `onStateChange` (`0` ended, `1` playing, `2` paused, `3` buffering, `5` cued) and `onAutoplayBlocked` ([IFrame API](https://developers.google.com/youtube/iframe_api_reference)). Track-end detection is easy and exact.
- "Embedded players must have a viewport that is at least 200px by 200px" (480×270 recommended for 16:9).
- [Developer Policies](https://developers.google.com/youtube/terms/developer-policies): III.I.7 forbids separating or isolating the audio, III.I.9 forbids playing "from a background player", III.I.4/III.I.6 forbid modifying or replacing player functionality, III.I.5 forbids blocking ads.
- **Consequences:** no audio-only mode, no hidden player, no lock-screen YouTube playback, no custom transport *replacing* YouTube's (your own buttons may *call* the API, but YouTube's player stays visible and intact), ads play when YouTube serves them, and some videos refuse embedding (errors `101`/`150`), commonly label-uploaded music videos.

### 4.2 Import: Data API v3

- Default 10,000 units/day. `playlists.list`, `playlistItems.list`, `videos.list`, `channels.list` cost **1 unit** each (up to 50 items per page). `search.list` now has its own bucket of 100 calls/day ([quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)). Importing ten 200-item playlists costs about 40 units.
- **Auth choice:** public or unlisted playlists need only an **API key** (server-side, no user OAuth). Private playlists and Liked videos need OAuth `youtube.readonly`. A Google project in **Testing** status issues refresh tokens that expire after 7 days, which is a nuisance. Recommendation: API key + make the playlists you want in the hub unlisted.
- Caching rule III.E.4.c: stored API data must be "delete[d] or refresh[ed]" after 30 days. The import job refreshes metadata at least every 30 days (`media_items.last_checked_at`).

### 4.3 Verdict

🟡 Import is easy. Playback works with a **visible** player only, which is natural on the laptop's right panel or a full-screen video sheet on mobile, and impossible in the background on iOS.

---

## 5. SoundCloud

- **API access for new apps:** "You need a SoundCloud Artist Pro subscription to register API applications and receive credentials" ([Get an API key](https://developers.soundcloud.com/docs/api/register-app)). Self-service registration reopened for Artist Pro subscribers in May 2026 (SoundCloud developer blog). Without Artist Pro: 🔴 no API key.
- **Widget API, no key needed:** `play/pause/toggle/seekTo/setVolume`, `next/prev/skip(index)` on multi-track widgets, `load(url)`. Events `READY, PLAY, PAUSE, FINISH, PLAY_PROGRESS, ERROR` ([Widget API](https://developers.soundcloud.com/docs/api/html5-widget)). Track-end detection via `FINISH` is exact.
- **oEmbed, no key in the documented example:** `https://soundcloud.com/oembed?format=json&url=…` "accepts any URL pointing to a user, set, or track" and returns `title`, `description` and the embed `html` ([oEmbed](https://developers.soundcloud.com/docs/oembed)).
- **Importing likes or playlists without a key:**
  1. Playlists (sets), public or secret-link: paste the URL → oEmbed for title/art → widget plays the whole set with next/prev. 🟢
  2. Likes: SoundCloud has no keyless likes export. Practical route: in SoundCloud, add the likes you care about to a set and import that set. A user's likes page URL might embed, but that's unverified and untested. 🟡
  3. Individual tracks: paste URLs. 🟢
- Limits: Go+ tracks play as 30-second previews in embeds, some uploads are geo-blocked, and the widget is a cross-origin iframe, so the page's Media Session can't own its audio.

**Verdict:** 🔴 for the API path (unless you buy Artist Pro), 🟢 for widget + oEmbed collections.

---

## 6. Mixed playlists: the conductor

### 6.1 Policy first

Before any engineering: Spotify Developer Policy **III.5** (no product "integrated with streams or content from another service") and **III.7** (no segue or mix with other audio), plus the Design Guideline "never seated next to content from similar services", make a mixed Spotify + YouTube/SoundCloud queue **a policy violation by design**. YouTube's side (III.F.2) only asks that non-YouTube content isn't presented as YouTube's. **Verdict: 🔴 policy**, whatever the technology allows. The roadmap therefore keeps it last, behind an explicit opt-in (open question 3 in `06-roadmap.md`).

What follows is the engineering answer the brief asked for, so the decision is made with full information.

### 6.2 Conductor design

The conductor is a client-side state machine that owns the *mix queue*. Spotify's queue is never used for it (append-only, §1.5). Each item is `{source, id, duration}`. Consecutive items of the same source form a **run**.

```
            ┌────────────── next run is Spotify ─────────────┐
            ▼                                                │
  [PREPARE] ─► [SPOTIFY_RUN] ── run end detected ──► [HANDOFF] ─► [INAPP_RUN: YT|SC] ── FINISH/ENDED ──┘
       ▲            │                                     │                │
       │            └─ external change (user skips in      │                └─ error 101/150, geo block → skip item, notify
       │               Spotify app / device switched) ──► [DIVERGED] ── user chooses: resume mix / stop
       └──────────── app resumed after suspension ───────── [RECOVER] (re-read Spotify state, recompute position)
```

- **Spotify run:** `PUT /me/player/play {uris: run, device_id}`. Playback stops after the last URI (unless Autoplay, see the failure modes). End detection: with the SDK as device, `player_state_changed` (`paused && position 0` after the last URI). With a Connect device, the scheduled poll at `duration − progress` on the last item.
- **Handoff to in-app:** pre-cue the YouTube video or SoundCloud widget while the last Spotify track is playing (`cueVideoById`, `widget.load(url,{auto_play:false})`), then `playVideo()`/`play()` on detection. Spotify is already stopped, so nothing overlaps (III.7 forbids overlap anyway, so no crossfade).
- **Handoff back to Spotify:** on `ENDED` / `FINISH` → `PUT /me/player/play {uris: nextRun}`.
- **Telemetry:** every handoff logs `gap_ms` and outcome to `handoff_events` so "does this work" becomes measurable.

### 6.3 Failure modes

| # | Failure | Where | Effect | Mitigation |
|---|---|---|---|---|
| F1 | App backgrounded or locked → JavaScript suspended | iOS (always), laptop when the browser is closed | Spotify run ends, **nothing starts YouTube**. YouTube may not play in the background anyway (III.I.9). In-app run ends, nothing restarts Spotify. | iOS: only "Relay mode" (6.4). Laptop: keep the hub tab/PWA open. |
| F2 | Track-end detection latency | Connect device (polling) | 0.4–5 s silence or overrun | Scheduled poll at the computed end. On the laptop, use the SDK device for exact events. |
| F3 | Device Autoplay continues after the `uris` list | Any Connect device with Autoplay on | Spotify radio starts instead of the handoff | Detect `item.uri ∉ run` → `pause` immediately (≤1 poll of bleed). Advise switching Autoplay off on that device. |
| F4 | Spotify queue append-only | Always | Can't stage or remove; user-queued songs jump in | Never stage; play each run as a fresh `uris` list. User-queued items show as "outside the mix" and the conductor waits for them. |
| F5 | Different audio outputs | Spotify on speaker/phone, YouTube in the laptop/phone browser | The music *moves* between rooms or devices at a handoff | Mixed mode is only offered when the Spotify device is "This laptop" (SDK) or the Spotify app on the *same* device. Otherwise blocked with an explanation. |
| F6 | User acts in the Spotify app (skip, new playlist, transfer) | Any | The conductor's model diverges | Detect a context or URI mismatch → `DIVERGED` → banner "Mix paused: you're playing something else in Spotify". Never fight the user. |
| F7 | Device switch mid-run | Any | Run continues elsewhere, F5 applies | Re-evaluate F5. If outputs differ, pause the mix at the next handoff. |
| F8 | YouTube ad before or within the video | YouTube | Unknown extra duration; can't skip (III.I.5) | Accept. Show "YouTube ad" state. Durations are estimates. |
| F9 | Embed disabled / geo-blocked / removed (`101`/`150`/`100`) | YouTube, SoundCloud | Item can't play | Skip with a toast. Validate embeddability during import (`videos.list status.embeddable`). |
| F10 | Autoplay blocked (no user gesture) | iOS always, desktop sometimes | `playVideo()` refused, so silence | iOS: the handoff needs a tap ("Tap to continue on YouTube"). Desktop PWA: autoplay with sound is allowed for installed PWAs (Chrome 73+). |
| F11 | Gaps / loudness jumps | All | 1–3 s gap, level differences | Pre-cue. Per-source volume offset for YT/SC (can't touch Spotify's loudness). |
| F12 | Order of execution not guaranteed | Spotify | A `play` racing a `pause` | Serialised command queue (§1.5). |
| F13 | SoundCloud Go+ previews | SoundCloud | Track ends after 30 s | Flag at import (`duration` vs full length). Exclude from mixes. |
| F14 | Quota | Spotify | Tighter polling during mixes uses the shared quota faster | Mixed sessions count toward the budget. Use the SDK device on the laptop (zero polling). |

### 6.4 The realistic best version

| | Laptop (Chrome/Edge PWA, Spotify on "This laptop" via SDK) | iPhone PWA |
|---|---|---|
| Spotify part | SDK in the same page: exact events, zero polling | Spotify app (Connect). The page can't observe it while suspended. |
| YouTube/SC part | Visible player in the right panel; desktop allows autoplay for installed PWAs | Visible full-screen sheet; needs a tap; stops when locked |
| Gap per handoff | ~1–2 s (estimate) | Unbounded while the phone is locked |
| Best achievable | **Seamless-ish continuous mix while the PWA window stays open** | **"Relay mode":** the server watches the Spotify run (poll every 10 s during an active mix) and sends a **Web Push** at the run's end: "Spotify part done, tap to continue on YouTube". YouTube runs need the screen on. Honest UX: "a playlist with stops", not a gapless queue. |
| Verdict | 🟡 | 🔴 for seamless, 🟡 for relay |

### 6.5 Recommendation

Don't build the mixed queue as a core feature. If you want it after reading 6.1, build it last (Release 5), laptop-first, behind a per-device opt-in labelled as conflicting with Spotify's policy, with no YouTube/SoundCloud items ever *rendered* inside Spotify lists. The compliant substitute that delivers most of the value: **separate spaces** ("Spotify" and "Elsewhere") in one app, each with its own player, and one shared stats layer for the listening log.

---

## 7. iOS PWA

| Aspect | Status | Notes |
|---|---|---|
| Standalone mode | 🟢 | Since iOS 26, sites added to the Home Screen open as web apps by default (community guides). Use `display: standalone`, `viewport-fit=cover`, safe-area insets. |
| Background execution | 🔴 | JavaScript timers and fetches stop shortly after the PWA is backgrounded or locked. There is no background sync for this use. **Polling stops**, which is fine: the hub polls again on `visibilitychange`. |
| Audio in background (own `<audio>`) | 🟡 | Works for simple element playback. Community reports: WebKit can close the audio session at a natural track end (workarounds involve `loop` tricks), and Media Session handlers must be (re)registered after the element becomes "Now Playing" (open WebKit bugs 261858, 243258, 295518). Not needed in remote-control mode. |
| Media Session / lock-screen controls | 🟡 | Only reflect media the **page itself** plays. In remote-control mode nothing plays in the page, so the lock screen shows **the Spotify app's** controls, which is exactly right. Faking a session with silent audio to hijack the lock screen is fragile and pointless here. |
| Web Push | 🟢 | iOS 16.4+ for Home-Screen web apps. Useful for "daily pick ready", "token expires in 7 days", "ingest stale", and Relay mode. |
| Screen Wake Lock | 🟢 | Optional "keep screen on" during YouTube sessions. |
| Deep links into Spotify | 🟢 | `spotify:playlist:…` opens the Spotify app. Used for "Wake Spotify" (§1.5). |

**Verdict:** 🟢 as a remote and dashboard, 🔴 as an independent background player. That's why the iPhone design never makes the PWA the Spotify speaker.

---

## 8. Laptop: installable PWA vs Tauri vs Electron

| Capability | Installed PWA (Chrome/Edge) | Tauri 2 | Electron |
|---|---|---|---|
| Web Playback SDK ("This laptop") | 🟢 | 🔴/unverified (WKWebView/WebView2, outside "supported browsers") | 🔴 (Spotify: SDK not supported in Electron; Widevine licence fails) |
| Own window, dock icon, offline shell | 🟢 | 🟢 | 🟢 |
| Hardware media keys | 🟡 Chrome routes media keys to the page **while it plays media** (Chrome 73+, foreground or background). Works when "This laptop" plays via the SDK. When Spotify plays elsewhere, keys go to whatever is playing locally (often the Spotify desktop app) | 🟢 global shortcuts plugin can register media keys system-wide → remote-control any device | 🟢 `globalShortcut` |
| Menu-bar / tray "now playing" | 🔴 | 🟢 | 🟢 |
| Background polling | 🟡 throttled to ~1/min after 5 min hidden, unless playing audio | 🟢 native timers | 🟢 |
| Launch at login | 🟡 (Chrome "start app when you sign in" on some platforms) | 🟢 | 🟢 |
| Notifications | 🟢 Web Push | 🟢 native | 🟢 |
| Build/signing overhead | none | Rust toolchain; macOS notarisation optional for personal use | ~150 MB bundle; castlabs fork + VMP signing for DRM, which still fails for Spotify |

**Recommendation:** one SvelteKit codebase, installed as a PWA on the laptop (Release 1). A **Tauri menu-bar companion** is a later nice-to-have (global media keys + tray now-playing) that *loads the same web app*. It would control Spotify via the Web API only and leave "This laptop" playback to the browser PWA. Electron: no.

---

## 9. Incidental findings while reading the repo (not hub-specific, but urgent)

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| I1 | **Keepalive workflow has never succeeded.** Its push to `main` is rejected with `GH013: Repository rule violations… Changes must be made through a pull request` | `gh run list --workflow keepalive.yml`: failures on 2026-09-11, 10-01, 11-01. Repo `pushed_at` = **2026-09-29** | GitHub disables scheduled workflows after 60 days without repository activity, so **every cron stops around 2026-11-28** unless something is pushed or merged first. Same failure mode as the September outage. |
| I2 | **Spotify refresh token expiry** (§0.2) | Scope change + `.env` dated 2026-05-21 | Probable cron-wide Spotify failure **around 2026-11-21**. |
| I3 | Migration number **0017 is missing** on `main` (0016 → 0018). It existed on the unmerged v0.71 audio-features branch (`cc0f593`) | `ls migrations/`, `git log --all -- 'migrations/0017*'` | The hub migrations proposed here start at **0019** to avoid colliding with a later 0017. |
| I4 | Overview stats are slow: `COUNT(*)` + two `COUNT(DISTINCT)` over `unified_plays` took **8.9 s cold / 1.1 s warm**; the current-streak query **3.6 s**; "On this day" **4.0 s** (420k plays, seq scans, external merge sorts on disk) | `EXPLAIN ANALYZE`, 2026-11-03 | The hub's home tiles must not run these live (`04-architecture.md` §6 measures and fixes them). |
| I5 | `scripts/feature_coverage.py` notes "batch lookups are gone" while `lib/track_metadata.py` still uses batch `sp.tracks()` and still gets `popularity` | DB: October rows 179/179 with popularity | The current Client ID still enjoys the **postponed** pre-2026 endpoint set (§0.1). That will end on a date Spotify hasn't announced. Plan for it in the cron code too. |

I1 and I2 are outside this run's scope (hard rule 1: no workflow or source edits). They are listed so you can fix them before the hub depends on the crons.

---

## Sources

Spotify
- [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
- [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)
- [February 2026 Dev Mode migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Update on Developer Access and Platform Security (2026-02-06)](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)
- [Web API quota updates for Development Mode (2026-07-23)](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)
- [Introducing refresh token expiration (2026-06-18)](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration)
- [Changes to the Web API (2024-11-27)](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
- [Start/Resume Playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback) · [Add Item to Playback Queue](https://developer.spotify.com/documentation/web-api/reference/add-to-queue)
- [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)
- [Developer Policy](https://developer.spotify.com/policy) · [Design & branding guidelines](https://developer.spotify.com/documentation/design)
- [Spotify Soloist overview](https://developer.spotify.com/documentation/soloist/concepts/overview) · [Soloist WebSocket API](https://developer.spotify.com/documentation/soloist/reference/websocket-api)
- [Community: Web Playback SDK in Electron / Widevine licence 500](https://community.spotify.com/t5/Spotify-for-Developers/WebSDK-500-error-on-license-endpoint-after-successful-device/m-p/6975176/highlight/true)
- [TechCrunch, 2026-02-06](https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/)

YouTube
- [IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
- [Data API quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)

SoundCloud
- [Get an API key](https://developers.soundcloud.com/docs/api/register-app)
- [HTML5 Widget API](https://developers.soundcloud.com/docs/api/html5-widget)
- [oEmbed](https://developers.soundcloud.com/docs/oembed)

iOS / browsers
- [Getting my iPhone music app to keep playing on the lock screen (DEV)](https://dev.to/amsyeung/getting-my-iphone-music-app-to-keep-playing-on-the-lock-screen-91f)
- [PWAs on iOS & iPadOS](https://progressivewebapps.com/platforms/ios-safari/)
- [Chrome 73 media updates (hardware media keys, Media Session on desktop)](https://developer.chrome.com/blog/media-updates-in-chrome-73)
