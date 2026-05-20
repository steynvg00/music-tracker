# Ingesting Spotify Extended Streaming History

## 1. What this is

Spotify offers two data export tiers:

- **Account data** (fast, ~5 days) — only the last 12 months of plays.
- **Extended Streaming History** (slow, up to 30 days) — your full lifetime listening history, with richer metadata: ms played, platform, country, shuffle/skip/offline flags, reason_start/end.

This pipeline ingests the Extended export into the `spotify_plays` table. It is separate from the last.fm `scrobbles` table — the two data sources coexist.

## 2. Requesting your export

1. Go to <https://www.spotify.com/account/privacy/>
2. Scroll to **Download your data**
3. Under *Extended streaming history*, click **Request data**
4. Spotify emails you a download link within **up to 30 days** (usually faster)

## 3. Unpacking the files

Unzip the archive into `data/spotify_extended/` (this directory is gitignored):

```bash
mkdir -p data/spotify_extended
unzip ~/Downloads/my_spotify_data.zip -d data/spotify_extended/
```

Relevant files:
- `Streaming_History_Audio_*.json` — music, podcasts, and audiobooks. **Ingest these.**
- `Streaming_History_Video_*.json` — video content. **Skip these** (not useful for music stats).

Each file contains a JSON array of play events.

## 4. Applying the migration

Run the migration once against your Supabase database before ingesting:

```bash
psql $DATABASE_URL -f migrations/0003_spotify_plays.sql
```

This creates the `spotify_plays` table and its indexes. The migration is idempotent (`IF NOT EXISTS` throughout).

## 5. Running the ingest

```bash
uv run python scripts/ingest_spotify_history.py --path data/spotify_extended/
```

Use `--dry-run` to parse and count without writing anything to the DB:

```bash
uv run python scripts/ingest_spotify_history.py --path data/spotify_extended/ --dry-run
```

Use `--verbose` for per-file progress lines:

```bash
uv run python scripts/ingest_spotify_history.py --path data/spotify_extended/ --verbose
```

You can also point `--path` at a single file instead of the whole directory.

## 6. Re-running

The ingest is **idempotent**. When you re-import a fresh Extended export, records are upserted via `ON CONFLICT DO UPDATE` with COALESCE — non-NULL fields from the export fill in any NULLs left by the recently-played cron, and existing rich-field values are never overwritten by NULL.

The "Skipped (already in DB)" count in the summary tells you how many rows had no new fields to merge.

## 7. Ongoing capture via Spotify Web API

A GitHub Actions cron job runs every 30 minutes and pulls the last 50 plays from Spotify's `/me/player/recently-played` endpoint, inserting them into `spotify_plays` via `ON CONFLICT DO NOTHING`. This keeps the dashboard current without waiting for a full Extended export.

Rows inserted by the cron have `ms_played`, `reason_end`, `shuffle`, `skipped`, and all other rich fields set to NULL — the API endpoint does not return them.

To backfill those fields, re-request the Extended export every 1–4 times per year and re-run `scripts/ingest_spotify_history.py`. The `ON CONFLICT DO UPDATE SET … COALESCE(EXCLUDED.x, spotify_plays.x)` logic will fill in NULLs from the export without touching values already present, so re-running is always safe.
