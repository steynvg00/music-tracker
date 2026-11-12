/**
 * Settings › Data health (R8). One payload with everything Streamlit and the crons can tell you
 * about the data: last ingest per source, cron health (GitHub API), enrichment coverage, rollup
 * refresh, database size against the free-tier cap, both Spotify tokens, radar sources, phantom
 * plays and the last digest. Every block degrades on its own: a missing table (a migration not
 * applied yet) blanks that block, never the page.
 */
import type { Queryable } from '$lib/server/db';
import type { HubConfig } from './env';
import { connectionStatus, type ConnectionStatus } from './spotify/token';
import { cronHealth } from './github-health';
import { radarSources } from './radar';
import { phantomSummary } from './phantom';
import { pushDevices } from './notifications';
import { cacheHealth } from './catalog/cache';
import { tableTone, weekGrowth, type SizeSnapshot } from '$lib/shared/health';
import { DB_CAP_BYTES, DB_WARN_BYTES, dbTone, freshnessTone, type DataHealth, type IngestSource, type Tone, type TokenLine } from '$lib/shared/health';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
	try {
		return await p;
	} catch {
		return fallback;
	}
}

function tokenLine(c: ConnectionStatus): TokenLine {
	const tone: Tone = !c.connected ? 'info' : c.health === 'danger' ? 'danger' : c.health === 'warn' ? 'warn' : 'ok';
	return { client: c.client, connected: c.connected, expiresAt: c.expiresAt, daysLeft: c.daysLeft, lastRefreshAt: c.lastRefreshAt, lastError: c.lastError, tone };
}

interface Stamps {
	plays_ingested: Date | null;
	plays_played: Date | null;
	liked: Date | null;
	mirror: Date | null;
	picks: Date | null;
	metadata: Date | null;
	track_pop: Date | null;
	artist_pop: Date | null;
	badges: Date | null;
}

export async function dataHealth(
	sql: Queryable,
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	f: typeof fetch = fetch,
	now: Date = new Date(),
	opts: { fresh?: boolean } = {}
): Promise<DataHealth> {
	const [stamps, enrich, rollup, size, tables, conns, cron, radar, radarRun, phantom, digest, devices, catalogCache, lastfm] = await Promise.all([
		sql<Stamps[]>`
			SELECT (SELECT max(ingested_at) FROM spotify_plays) AS plays_ingested,
			       (SELECT max(played_at) FROM spotify_plays) AS plays_played,
			       (SELECT max(synced_at) FROM liked_songs) AS liked,
			       (SELECT max(last_seen_at) FROM spotify_playlists) AS mirror,
			       (SELECT max(generated_at) FROM daily_pick_candidates) AS picks,
			       (SELECT max(enriched_at) FROM track_metadata) AS metadata,
			       (SELECT max(computed_at) FROM track_popularity_scores) AS track_pop,
			       (SELECT max(computed_at) FROM artist_popularity_scores) AS artist_pop,
			       (SELECT max(awarded_at) FROM badge_events) AS badges`.then((r) => r[0]!),
		soft(
			sql<{ tracks: number; enriched: number; dur: number; artists: number; isrc: number }[]>`
				SELECT count(*)::int AS tracks,
				       count(tm.track_uri)::int AS enriched,
				       count(tm.duration_ms)::int AS dur,
				       count(*) FILTER (WHERE cardinality(tm.artist_ids) > 0)::int AS artists,
				       count(tm.isrc)::int AS isrc
				FROM hub.mv_track_stats ts LEFT JOIN track_metadata tm ON tm.track_uri = ts.track_uri`.then((r) => r[0] ?? null),
			null
		),
		soft(
			sql<{ refreshed_at: Date; took_ms: number; full_rebuilt_at: Date | null; ingested_mark: Date | null; sizes: SizeSnapshot[] | null }[]>`
				SELECT refreshed_at, took_ms, full_rebuilt_at, ingested_mark, detail -> 'sizes' AS sizes FROM hub.rollup_state LIMIT 1`.then((r) => r[0] ?? null),
			null
		),
		sql<{ bytes: string }[]>`SELECT pg_database_size(current_database())::text AS bytes`.then((r) => Number(r[0]?.bytes ?? 0)),
		// v0.92: + dead tuples and the last (auto)vacuum, for bloat.
		sql<{ name: string; bytes: string; live: string | null; dead: string | null; vac: Date | null }[]>`
			SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name,
			       pg_total_relation_size(c.oid)::text AS bytes,
			       s.n_live_tup::text AS live, s.n_dead_tup::text AS dead, greatest(s.last_vacuum, s.last_autovacuum) AS vac
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
			WHERE c.relkind IN ('r', 'm') AND n.nspname IN ('public', 'hub')
			ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`,
		connectionStatus(sql, now),
		cronHealth(cfg, f, now, opts),
		soft(radarSources(sql), null),
		soft(sql<{ t: Date | null }[]>`SELECT max(ran_at) AS t FROM radar_runs`.then((r) => r[0]?.t ?? null), null),
		phantomSummary(sql),
		soft(
			sql<{ ran_at: Date; run_type: string; delivery_status: string | null }[]>`
				SELECT ran_at, run_type, delivery_status FROM digest_runs ORDER BY ran_at DESC LIMIT 1`.then((r) =>
				r[0] ? { lastAt: iso(r[0].ran_at), runType: r[0].run_type, delivery: r[0].delivery_status } : { lastAt: null, runType: null, delivery: null }
			),
			null
		),
		pushDevices(sql, now),
		// v0.90: blank when 0031 isn't applied.
		soft(cacheHealth(sql), null),
		// Historic last.fm import. Its own query: after 0033 (scrobbles archived + dropped) it is null.
		soft(sql<{ t: Date | null }[]>`SELECT max(played_at) AS t FROM scrobbles WHERE source = 'lastfm'`.then((r) => r[0]?.t ?? null), null)
	]);

	const src = (key: string, label: string, at: Date | null, everyH: number | null, detail: string | null = null): IngestSource => ({
		key,
		label,
		lastAt: iso(at),
		detail,
		expectedEveryH: everyH,
		tone: freshnessTone(iso(at), everyH, now)
	});
	const ingest: IngestSource[] = [
		{ ...src('recent', 'Spotify recently played', stamps.plays_ingested, 1), newestAt: iso(stamps.plays_played) },
		src('liked', 'Liked songs', stamps.liked, 24),
		src('mirror', 'Playlist mirror', stamps.mirror, 24),
		src('picks', 'Daily pick candidates', stamps.picks, 24),
		src('metadata', 'Track metadata enrichment', stamps.metadata, 24, 'only writes when there are new tracks'),
		src('track_pop', 'Track popularity scores', stamps.track_pop, 24),
		src('artist_pop', 'Artist popularity scores', stamps.artist_pop, 24),
		src('radar', 'Release radar', radarRun, 24),
		src('badges', 'Badges (last awarded)', stamps.badges, null),
		src('lastfm', 'Last.fm scrobbles (historic import)', lastfm, null, lastfm ? null : 'archived (0033) or not imported')
	];
	// Enrichment only writes when there's something new; judge it by coverage, not by age alone.
	const missing = enrich ? enrich.tracks - enrich.enriched : 0;
	const enrichTone: Tone = !enrich ? 'info' : missing > Math.max(50, enrich.tracks * 0.02) ? 'warn' : 'ok';
	const meta = ingest.find((s) => s.key === 'metadata')!;
	if (enrich && meta.lastAt) meta.tone = enrichTone;

	const lagMs = rollup?.ingested_mark && stamps.plays_ingested ? new Date(stamps.plays_ingested).getTime() - new Date(rollup.ingested_mark).getTime() : 0;
	return {
		generatedAt: now.toISOString(),
		ingest,
		cron,
		enrichment: {
			tracks: enrich?.tracks ?? 0,
			enriched: enrich?.enriched ?? 0,
			withDuration: enrich?.dur ?? 0,
			withArtists: enrich?.artists ?? 0,
			withIsrc: enrich?.isrc ?? 0,
			lastEnrichedAt: iso(stamps.metadata),
			audioFeatures: 'not_collected',
			tone: enrichTone
		},
		rollups: rollup
			? {
					refreshedAt: iso(rollup.refreshed_at),
					tookMs: rollup.took_ms,
					fullRebuiltAt: iso(rollup.full_rebuilt_at),
					ingestedMark: iso(rollup.ingested_mark),
					lastIngestAt: iso(stamps.plays_ingested),
					tone: lagMs > 2 * 3_600_000 ? 'warn' : freshnessTone(iso(rollup.refreshed_at), 1, now) === 'danger' ? 'warn' : 'ok'
				}
			: null,
		database: {
			bytes: size,
			capBytes: DB_CAP_BYTES,
			pct: Math.round((size / DB_CAP_BYTES) * 1000) / 10,
			tables: tables.map((t) => {
				const bytes = Number(t.bytes);
				const live = t.live === null ? null : Number(t.live);
				const dead = t.dead === null ? null : Number(t.dead);
				const deadPct = live !== null && dead !== null && live + dead > 0 ? Math.round((1000 * dead) / (live + dead)) / 10 : null;
				const g = weekGrowth(t.name, bytes, Array.isArray(rollup?.sizes) ? rollup.sizes : [], now.toISOString().slice(0, 10));
				return { name: t.name, bytes, liveTuples: live, deadTuples: dead, deadPct, lastVacuumAt: iso(t.vac), weekGrowthPct: g.pct, weekBaseDate: g.base, tone: tableTone(deadPct, g.pct) };
			}),
			tone: dbTone(size),
			warnBytes: DB_WARN_BYTES,
			overWarn: size > DB_WARN_BYTES
		},
		catalogCache,
		tokens: [tokenLine(conns.hub), tokenLine(conns.cron)],
		radar,
		phantom,
		digest,
		devices
	};
}
