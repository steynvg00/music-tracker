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

The ingest is **idempotent**. If Spotify sends you a fresh export (e.g. six months later), you can re-run the same command — records already in the DB will be skipped via `ON CONFLICT DO NOTHING`. Only new plays since your last export will be inserted.

The "Skipped (already in DB)" count in the summary tells you how many duplicates were detected.
