# music-tracker

Personal music tracker: Spotify listening history in Supabase Postgres, ~200 managed
Spotify playlists maintained by GitHub Actions crons, and **Rotor** (`hub/`), the SvelteKit
PWA that is the only frontend (v1.0 retired the Streamlit dashboard). Notifications are Web
Push from Rotor and the crons; there is no mail.

| Part | Where | Docs |
|---|---|---|
| Ingest + playlist crons | `scripts/`, `lib/`, `.github/workflows/scheduled-ingest.yml` | `docs/cron-setup.md` |
| Rotor hub: remote control, daily pick, library, custom playlists, rules, stats, Wrapped, release radar, This week, Data health, notifications | `hub/` | `hub/README.md`, `docs/hub-redesign/` |
| Schema | `migrations/` (applied by hand in the Supabase SQL editor) | `migrations/README.md` |

## Development

```bash
uv sync                                   # Python deps
uv run pytest -q                          # Python unit tests (DB + Spotify mocked)
cd hub && npm ci && npm run dev           # Rotor (needs hub/.env, see hub/.env.example)
cd hub && npm run check && npm test && npm run build
```

Feature spec: `docs/feature-spec.md`. Hub analysis and design: `docs/hub-redesign/`.
