# music-tracker

Personal music tracker: Spotify listening history in Supabase Postgres, ~200 managed
Spotify playlists maintained by GitHub Actions crons, a Streamlit dashboard, and
**Rotor** (`hub/`), the SvelteKit PWA that is replacing the dashboard.

| Part | Where | Docs |
|---|---|---|
| Ingest + playlist crons | `scripts/`, `lib/`, `.github/workflows/scheduled-ingest.yml` | `docs/cron-setup.md` |
| Streamlit dashboard (being retired) | `app.py`, `views/` | `docs/streamlit-cloud-deploy.md` |
| Rotor hub (v0.81+: remote control, daily pick; v0.82+: library, custom playlists, rules, jobs, notifications) | `hub/` | `hub/README.md`, `docs/hub-redesign/` |
| Schema | `migrations/` (applied by hand in the Supabase SQL editor) | `migrations/README.md` |

## Development

```bash
uv sync                                   # Python deps
uv run pytest -q                          # Python unit tests (DB + Spotify mocked)
uv run streamlit run app.py               # dashboard
cd hub && npm ci && npm run dev           # Rotor (needs hub/.env, see hub/.env.example)
cd hub && npm run check && npm test && npm run build
```

Feature spec: `docs/feature-spec.md`. Hub analysis and design: `docs/hub-redesign/`.
