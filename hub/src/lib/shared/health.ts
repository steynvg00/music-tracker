/**
 * Settings › Data health (R8): types and pure rules, shared by the server and the page.
 *
 * Cron auto-disable: GitHub disables a PUBLIC repository's scheduled workflows after 60 days
 * without repository activity. A push resets that clock, and so does keepalive.yml, which
 * re-enables every scheduled workflow through the REST API each Monday (v0.80.1). So the date
 * is max(last push, last successful keepalive run) + 60 days, the same for every scheduled
 * workflow. A private repository isn't subject to the rule.
 */
import type { RadarSourceHealth } from './radar';
import type { PushDevice } from './notifications';

export interface CatalogCacheHealth {
	artists: number;
	logicalBytes: number;
	physicalBytes: number;
	capBytes: number;
	ttlDays: number;
	hits: number;
	misses: number;
	hitRatePct: number | null;
	evictions: number;
	spotifyCalls: number;
	rateLimited: number;
	since: string | null;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info';

/** Every workflow with a `schedule:` trigger. A vitest checks this against .github/workflows/*.yml. */
export const SCHEDULED_WORKFLOWS: { file: string; name: string; schedule: string }[] = [
	{ file: 'scheduled-ingest.yml', name: 'Scheduled ingest', schedule: 'every 30 min + daily 03:00–05:00 + Mon 06:00 + 1st/15th 06:00 UTC' },
	{ file: 'hub-jobs.yml', name: 'Hub jobs', schedule: 'daily 05:47 UTC' },
	{ file: 'ingest-monitor.yml', name: 'Ingest freshness monitor', schedule: 'daily 21:13 UTC' },
	{ file: 'keepalive.yml', name: 'Keepalive', schedule: 'Mon 07:17 UTC' }
];

export const AUTO_DISABLE_DAYS = 60;
/** Supabase free tier database cap (roadmap risks 6 and 8). */
export const DB_CAP_BYTES = 500 * 1024 * 1024;
/** v0.90: above this Data health shows an explicit warning (writes start failing at the cap). */
export const DB_WARN_BYTES = 450 * 1024 * 1024;
const DAY = 86_400_000;

export interface IngestSource {
	key: string;
	label: string;
	lastAt: string | null;
	detail: string | null;
	/** Spotify recently played only: the newest play's time (lastAt is when it was ingested). */
	newestAt?: string | null;
	/** Hours after which it's late (amber); twice that is red. null = informational only. */
	expectedEveryH: number | null;
	tone: Tone;
}

export interface CronWorkflow {
	file: string;
	name: string;
	schedule: string;
	state: string | null; // active | disabled_inactivity | disabled_manually | … (GitHub's value)
	lastRunAt: string | null;
	lastConclusion: string | null; // success | failure | cancelled | … | null while running
	lastEvent: string | null;
	lastRunUrl: string | null;
	autoDisableAt: string | null;
	tone: Tone;
}

export interface CronHealth {
	/** false → everything below is unknown; `reason` says why. */
	known: boolean;
	reason: string | null;
	repoPrivate: boolean | null;
	lastPushAt: string | null;
	lastKeepaliveAt: string | null;
	autoDisableAt: string | null;
	daysLeft: number | null;
	workflows: CronWorkflow[];
	checkedAt: string;
}

/** v0.92: per large table: size, dead tuples (bloat until vacuum reuses them) and growth over ~a week. */
export interface TableHealth {
	name: string;
	bytes: number;
	liveTuples: number | null;
	deadTuples: number | null;
	/** dead / (live + dead), % */
	deadPct: number | null;
	lastVacuumAt: string | null;
	/** vs the size snapshot closest to 7 days ago (hub.rollup_state.detail->sizes, 0035); null without history */
	weekGrowthPct: number | null;
	weekBaseDate: string | null;
	tone: Tone;
}

export const GROWTH_WARN_PCT = 10;
export const DEAD_WARN_PCT = 20;

export interface SizeSnapshot {
	d: string;
	t: Record<string, number>;
}

/** Growth of `name` vs the newest snapshot that is at least 6 days old (≈ a week). */
export function weekGrowth(name: string, bytesNow: number, history: SizeSnapshot[], today: string): { pct: number | null; base: string | null } {
	const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86_400_000).toISOString().slice(0, 10);
	const old = [...history].filter((h) => h.d <= cutoff && typeof h.t?.[name] === 'number').sort((a, b) => b.d.localeCompare(a.d))[0];
	if (!old || !old.t[name]) return { pct: null, base: null };
	return { pct: Math.round(((bytesNow - old.t[name]!) / old.t[name]!) * 1000) / 10, base: old.d };
}

export function tableTone(deadPct: number | null, growthPct: number | null): Tone {
	if (growthPct !== null && growthPct > GROWTH_WARN_PCT) return 'warn';
	if (deadPct !== null && deadPct > DEAD_WARN_PCT) return 'warn';
	return 'ok';
}

export interface TokenLine {
	client: 'hub' | 'cron';
	connected: boolean;
	expiresAt: string | null;
	daysLeft: number | null;
	lastRefreshAt: string | null;
	lastError: string | null;
	tone: Tone;
}

export interface DataHealth {
	generatedAt: string;
	ingest: IngestSource[];
	cron: CronHealth;
	enrichment: {
		tracks: number;
		enriched: number;
		withDuration: number;
		withArtists: number;
		withIsrc: number;
		lastEnrichedAt: string | null;
		/** Spotify removed audio features for new apps (Nov 2024); music-tracker never stored them. */
		audioFeatures: 'not_collected';
		tone: Tone;
	};
	rollups: { refreshedAt: string | null; tookMs: number | null; fullRebuiltAt: string | null; ingestedMark: string | null; lastIngestAt: string | null; tone: Tone } | null;
	database: { bytes: number; capBytes: number; pct: number; tables: TableHealth[]; tone: Tone; warnBytes: number; overWarn: boolean };
	/** v0.90 Artist pages (beta) cache (0031); null when the migration isn't applied. */
	catalogCache: CatalogCacheHealth | null;
	tokens: TokenLine[];
	radar: RadarSourceHealth[] | null;
	phantom: { count: number; latestAt: string | null };
	digest: { lastAt: string | null; runType: string | null; delivery: string | null } | null;
	/** R9: every subscribed device; push is the only notification channel. */
	devices: PushDevice[];
}

/** Rule above. null when there is no activity date at all. */
export function autoDisableAt(lastPushAt: string | null, lastKeepaliveAt: string | null): string | null {
	const t = Math.max(lastPushAt ? Date.parse(lastPushAt) : 0, lastKeepaliveAt ? Date.parse(lastKeepaliveAt) : 0);
	return t > 0 ? new Date(t + AUTO_DISABLE_DAYS * DAY).toISOString() : null;
}

export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
	return iso ? Math.floor((Date.parse(iso) - now.getTime()) / DAY) : null;
}

/** ok within `everyH`·1.5, warn up to 3×, danger beyond; info when there's no expectation. */
export function freshnessTone(lastAt: string | null, everyH: number | null, now: Date = new Date()): Tone {
	if (everyH === null) return 'info';
	if (!lastAt) return 'danger';
	const h = (now.getTime() - Date.parse(lastAt)) / 3_600_000;
	return h > everyH * 3 ? 'danger' : h > everyH * 1.5 ? 'warn' : 'ok';
}

export function dbTone(bytes: number, cap = DB_CAP_BYTES): Tone {
	const pct = bytes / cap;
	return bytes > DB_WARN_BYTES || pct >= 0.9 ? 'danger' : pct >= 0.75 ? 'warn' : 'ok';
}

export function workflowTone(state: string | null, conclusion: string | null, daysLeft: number | null): Tone {
	if (state && state !== 'active') return 'danger';
	if (daysLeft !== null && daysLeft < 7) return 'danger';
	if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'warn';
	if (daysLeft !== null && daysLeft < 21) return 'warn';
	return state ? 'ok' : 'info';
}

export const TONE_COLOR: Record<Tone, string> = {
	ok: 'var(--success)',
	warn: 'var(--warning)',
	danger: 'var(--danger)',
	info: 'var(--text-3)'
};

export function fmtBytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	if (n >= 1024) return `${Math.round(n / 1024)} kB`;
	return `${n} B`;
}

/** "3 min ago", "5 h ago", "2 d ago" (relative to `now`). */
export function ago(iso: string | null, now: Date = new Date()): string {
	if (!iso) return 'never';
	const m = Math.round((now.getTime() - Date.parse(iso)) / 60000);
	if (m < 1) return 'just now';
	if (m < 90) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}
