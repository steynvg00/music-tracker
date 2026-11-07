/**
 * Stats (R3): shared types and pure helpers for the Stats screens, detail pages and Search.
 * Server queries live in $lib/server/stats/*; numbers follow views/stats.py exactly
 * (02-inventory.md §B, 06-roadmap.md R3 smoke test 1).
 */

// ── Time ranges (Stats › Top) ────────────────────────────────────────────────

export type RangeKind = 'all' | 'this_year' | 'last_year' | 'year' | 'range';

export interface StatsRange {
	kind: RangeKind;
	/** Canonical key for URLs: all · this_year · last_year · year-2024 · range-2024-01-01_2024-06-30 */
	key: string;
	/** Inclusive local dates (YYYY-MM-DD); null = no bound (all time). */
	start: string | null;
	end: string | null;
	label: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(s: string): boolean {
	if (!ISO_DAY.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Parse a range key against `today` (YYYY-MM-DD, Europe/Amsterdam). Unknown keys → all time. */
export function parseRange(key: string | null | undefined, today: string): StatsRange {
	const year = Number(today.slice(0, 4));
	const k = (key ?? 'all').trim();
	if (k === 'this_year') return { kind: 'this_year', key: k, start: `${year}-01-01`, end: `${year}-12-31`, label: `This year (${year})` };
	if (k === 'last_year') return { kind: 'last_year', key: k, start: `${year - 1}-01-01`, end: `${year - 1}-12-31`, label: `Last year (${year - 1})` };
	const y = /^year-(\d{4})$/.exec(k);
	if (y) {
		const n = Number(y[1]);
		if (n >= 1990 && n <= year) return { kind: 'year', key: k, start: `${n}-01-01`, end: `${n}-12-31`, label: String(n) };
	}
	const r = /^range-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(k);
	if (r && validDay(r[1]!) && validDay(r[2]!) && r[1]! <= r[2]!) {
		return { kind: 'range', key: k, start: r[1]!, end: r[2]!, label: `${r[1]} → ${r[2]}` };
	}
	return { kind: 'all', key: 'all', start: null, end: null, label: 'All time' };
}

export function rangeKey(kind: RangeKind, opts: { year?: number; start?: string; end?: string } = {}): string {
	if (kind === 'year' && opts.year) return `year-${opts.year}`;
	if (kind === 'range' && opts.start && opts.end) return `range-${opts.start}_${opts.end}`;
	return kind === 'year' || kind === 'range' ? 'all' : kind;
}

// ── Rankings (same options as the Streamlit Top tab) ─────────────────────────

export const TRACK_RANKS = {
	plays: { label: 'Total plays', column: null },
	composite: { label: 'Composite popularity', column: 'composite_score' },
	sticky: { label: 'Sticky (current obsession)', column: 'sticky_pct' },
	evergreen: { label: 'Evergreen (sustained over years)', column: 'evergreen_pct' },
	flash: { label: 'Flash hit (brief explosion)', column: 'flash_hit_pct' },
	loop: { label: 'Session loop (replay behaviour)', column: 'session_loop_pct' }
} as const;
export type TrackRank = keyof typeof TRACK_RANKS;

export const ARTIST_RANKS = {
	plays: { label: 'Total plays', column: null },
	composite: { label: 'Composite popularity', column: 'composite_score' },
	sticky: { label: 'Sticky (current obsession)', column: 'sticky_pct' },
	evergreen: { label: 'Evergreen (sustained over years)', column: 'evergreen_pct' },
	depth: { label: 'Depth (catalogue coverage)', column: 'depth_pct' },
	saved: { label: 'Saved (Liked Songs curation)', column: 'saved_count_pct' }
} as const;
export type ArtistRank = keyof typeof ARTIST_RANKS;

export function isTrackRank(v: unknown): v is TrackRank {
	return typeof v === 'string' && v in TRACK_RANKS;
}
export function isArtistRank(v: unknown): v is ArtistRank {
	return typeof v === 'string' && v in ARTIST_RANKS;
}

/** Score display like Streamlit: composite as 0.000, the percentile scores as whole %. */
export function fmtScore(rank: TrackRank | ArtistRank, score: number | null): string {
	if (score === null) return '';
	return rank === 'composite' ? score.toFixed(3) : `${Math.round(score * 100)}%`;
}

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface RankedTrack {
	rank: number;
	/** Canonical track URI (variants collapsed under one ISRC), or the raw URI. */
	uri: string | null;
	name: string;
	artist: string;
	plays: number;
	score?: number | null;
	/** First credited artist's Spotify id, for the artist link. */
	artistId?: string | null;
}

export interface RankedArtist {
	rank: number;
	name: string;
	id: string | null;
	plays: number;
	score?: number | null;
}

export interface RankedAlbum {
	rank: number;
	name: string;
	artist: string;
	albumId: string | null;
	uniqueTracks: number;
	plays: number;
	playsPerTrack?: number;
}

/** One row of a Stats list (RankList.svelte). */
export interface RankRow {
	key: string;
	rank?: number;
	title: string;
	href?: string | null;
	subtitle?: string;
	subHref?: string | null;
	value: string;
	uri?: string | null;
}

export interface SeriesPoint {
	/** YYYY-MM or YYYY-MM-DD or a label */
	x: string;
	y: number;
}

// ── Patterns ─────────────────────────────────────────────────────────────────

export const WEEKDAYS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAYS_SUN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Postgres DOW (0 = Sunday) rows → 7×24 grid with Monday first, like the Streamlit heatmap. */
export function heatmapGrid(rows: { dow: number; hour: number; plays: number }[]): number[][] {
	const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
	for (const r of rows) {
		if (r.dow < 0 || r.dow > 6 || r.hour < 0 || r.hour > 23) continue;
		grid[(r.dow + 6) % 7]![r.hour] = (grid[(r.dow + 6) % 7]![r.hour] ?? 0) + r.plays;
	}
	return grid;
}

/** Fill a sparse daily series to every day from `start` to `end` inclusive (YYYY-MM-DD). */
export function fillDays(rows: { d: string; plays: number }[], start: string, end: string): SeriesPoint[] {
	const by = new Map(rows.map((r) => [r.d, r.plays]));
	const out: SeriesPoint[] = [];
	const t = new Date(`${start}T00:00:00Z`);
	const stop = new Date(`${end}T00:00:00Z`).getTime();
	while (t.getTime() <= stop && out.length < 400) {
		const k = t.toISOString().slice(0, 10);
		out.push({ x: k, y: by.get(k) ?? 0 });
		t.setUTCDate(t.getUTCDate() + 1);
	}
	return out;
}

/** "▲ 12%" / "▼ 3" style difference for Compare and Year in review. */
export function diff(a: number, b: number): { text: string; dir: 'up' | 'down' | 'flat' } {
	const d = a - b;
	if (d === 0) return { text: '±0', dir: 'flat' };
	const pct = b > 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / b) * 100)}%)` : '';
	return { text: `${d > 0 ? '+' : '−'}${new Intl.NumberFormat('en-GB').format(Math.abs(d))}${pct}`, dir: d > 0 ? 'up' : 'down' };
}

export const MILESTONES = [1, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000] as const;

export function ordinal(n: number): string {
	const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
	return `${new Intl.NumberFormat('en-GB').format(n)}${s}`;
}

// ── Badges (port of views/_badge_display.py + lib/artist_badges.py) ─────────

export interface BadgeCategory {
	name: string;
	emoji: string;
	types: string[];
}

export const TRACK_BADGE_CATEGORIES: BadgeCategory[] = [
	{ name: 'Play milestones', emoji: '🏆', types: ['plays_50', 'plays_100', 'plays_200', 'plays_300', 'plays_400', 'plays_500'] },
	{ name: 'Rankings', emoji: '🥇', types: ['top_1st_month', 'top_1st_season', 'top_1st_year', 'top_1st_alltime', 'top_1st_decade'] },
	{ name: 'Rankings meta', emoji: '👑', types: ['dominant', 'sovereign'] },
	{ name: 'Streaks', emoji: '🔥', types: ['streak_5_years', 'streak_8_years', 'streak_10_years'] },
	{ name: 'Daily intensity', emoji: '⚡', types: ['plays_20_in_day', 'plays_40_in_day', 'plays_60_in_day'] },
	{ name: 'Release timing', emoji: '🎬', types: ['played_on_day_one', 'day_one_fan', 'release_week_fan', 'late_bloomer'] },
	{ name: 'Behavioral', emoji: '🎭', types: ['comeback', 'season_regular', 'multi_top', 'on_repeat'] }
];

const ARTIST_PLAYS = [100, 250, 500, 1000, 2500, 5000];
const ARTIST_TRACKS = [5, 15, 30, 50, 100];
const ARTIST_STREAKS = [3, 5, 10];

export const ARTIST_BADGE_CATEGORIES: BadgeCategory[] = [
	{ name: 'Cumulative plays', emoji: '🏆', types: ARTIST_PLAYS.map((n) => `artist_plays_${n}`) },
	{ name: 'Distinct tracks', emoji: '📀', types: ARTIST_TRACKS.map((n) => `artist_tracks_${n}`) },
	{ name: 'Streaks', emoji: '🔥', types: ARTIST_STREAKS.map((n) => `artist_streak_${n}_years`) },
	{
		name: 'Rankings',
		emoji: '🎤',
		types: ['top_1st_artist_month', 'top_1st_artist_season', 'top_1st_artist_year', 'top_1st_artist_alltime', 'top_1st_artist_decade']
	},
	{ name: 'Dynasty', emoji: '👑', types: ['dynasty'] },
	{ name: 'Rediscovery', emoji: '🎭', types: ['rediscovery'] }
];

export const BADGE_LABELS: Record<string, string> = {
	plays_50: '50+',
	plays_100: '100+',
	plays_200: '200+',
	plays_300: '300+',
	plays_400: '400+',
	plays_500: '500+',
	top_1st_month: '#1 Month',
	top_1st_season: '#1 Season',
	top_1st_year: '#1 Year',
	top_1st_alltime: '#1 All-time',
	top_1st_decade: '#1 Decade',
	dominant: 'Dominant',
	sovereign: 'Sovereign',
	streak_5_years: '5-year',
	streak_8_years: '8-year',
	streak_10_years: '10-year',
	plays_20_in_day: '20/day',
	plays_40_in_day: '40/day',
	plays_60_in_day: '60/day',
	played_on_day_one: 'Day one',
	day_one_fan: 'Day-one fan',
	release_week_fan: 'Release week',
	late_bloomer: 'Late bloomer',
	comeback: 'Comeback',
	season_regular: 'Season regular',
	multi_top: 'Multi-top',
	on_repeat: 'On repeat',
	...Object.fromEntries(ARTIST_PLAYS.map((n) => [`artist_plays_${n}`, `${n}+ plays`])),
	...Object.fromEntries(ARTIST_TRACKS.map((n) => [`artist_tracks_${n}`, `${n}+ tracks`])),
	...Object.fromEntries(ARTIST_STREAKS.map((n) => [`artist_streak_${n}_years`, `${n}-year`])),
	top_1st_artist_month: '#1 Month',
	top_1st_artist_season: '#1 Season',
	top_1st_artist_year: '#1 Year',
	top_1st_artist_alltime: '#1 All-time',
	top_1st_artist_decade: '#1 Decade',
	dynasty: 'Dynasty',
	rediscovery: 'Rediscovery'
};

/** Same files as lib/badges.BADGE_ICONS (assets/badges → hub/static/badges, 128 px). */
export const BADGE_ICONS: Record<string, string> = {
	plays_50: '50_plays',
	plays_100: '100_plays',
	plays_200: '200_plays',
	plays_300: '300_plays',
	plays_400: '400_plays',
	plays_500: '500_plays',
	top_1st_month: 'month_1',
	top_1st_season: 'season_1',
	top_1st_year: 'year_1',
	top_1st_alltime: 'mythic',
	top_1st_decade: 'legend',
	streak_5_years: 'loyalist',
	streak_10_years: 'immortal',
	plays_20_in_day: 'binge',
	plays_40_in_day: 'obsession',
	played_on_day_one: 'first_spin',
	day_one_fan: 'day_one',
	release_week_fan: 'fresh_cut',
	late_bloomer: 'slow_burn',
	comeback: 'revival',
	season_regular: 'evergreen',
	multi_top: 'reigning'
};

export function badgeIcon(type: string): string | null {
	const f = BADGE_ICONS[type];
	return f ? `/badges/${f}.png` : null;
}

export function badgeLabel(type: string): string {
	return BADGE_LABELS[type] ?? type.replaceAll('_', ' ');
}

/** Once-per-lifetime badges; everything else can fire per window (×N). */
const SINGLE_FIRE = new Set([
	'plays_50',
	'plays_100',
	'plays_200',
	'plays_300',
	'plays_400',
	'plays_500',
	'dominant',
	'sovereign',
	'streak_5_years',
	'streak_8_years',
	'streak_10_years',
	'played_on_day_one',
	'day_one_fan',
	'release_week_fan',
	'late_bloomer',
	'season_regular',
	'multi_top',
	'on_repeat'
]);

export interface BadgeEvent {
	badgeType: string;
	entityType: 'track' | 'artist';
	entityId: string;
	awardedAt: string;
	context: Record<string, unknown>;
	name?: string | null;
	artist?: string | null;
}

export interface BadgeChip {
	type: string;
	label: string;
	icon: string | null;
	earned: boolean;
	count: number;
	firstAt: string | null;
	details: string[];
}

export interface BadgeGridCategory {
	name: string;
	emoji: string;
	chips: BadgeChip[];
}

/** Earned-vs-available grid, like render_badge_chips(): every slot shown, earned ones bright. */
export function badgeGrid(entity: 'track' | 'artist', events: BadgeEvent[]): BadgeGridCategory[] {
	const cats = entity === 'track' ? TRACK_BADGE_CATEGORIES : ARTIST_BADGE_CATEGORIES;
	const by = new Map<string, BadgeEvent[]>();
	for (const e of events) by.set(e.badgeType, [...(by.get(e.badgeType) ?? []), e]);
	return cats.map((c) => ({
		name: c.name,
		emoji: c.emoji,
		chips: c.types.map((t) => {
			const list = (by.get(t) ?? []).sort((a, b) => a.awardedAt.localeCompare(b.awardedAt));
			const single = entity === 'track' && SINGLE_FIRE.has(t);
			const shown = single ? list.slice(0, 1) : list;
			return {
				type: t,
				label: badgeLabel(t),
				icon: badgeIcon(t),
				earned: list.length > 0,
				count: single ? Math.min(1, list.length) : list.length,
				firstAt: list[0]?.awardedAt ?? null,
				details: shown.map((e) => describeBadge(t, e.context))
			};
		})
	}));
}

function monthsBetween(earlier: string, later: string): number | null {
	const a = /^(\d{4})-(\d{2})/.exec(earlier);
	const b = /^(\d{4})-(\d{2})/.exec(later);
	if (!a || !b) return null;
	return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

const s = (v: unknown, fallback = '?') => (v === undefined || v === null ? fallback : String(v));

/** Port of _format_badge_context(): one readable line per earned badge. */
export function describeBadge(type: string, c: Record<string, unknown> = {}): string {
	const plays = /^plays_(\d+)$/.exec(type);
	if (plays) return `Reached ${plays[1]} cumulative plays`;
	if (type.startsWith('top_1st_artist_')) return `${s(c.window, 'this period')} · ${s(c.plays)} plays`;
	if (type.startsWith('top_1st_')) {
		const parts = [s(c.window, 'this period')];
		if (c.plays_in_window != null) parts.push(`${c.plays_in_window} plays`);
		if (c.rank_2_gap != null) parts.push(`${c.rank_2_gap} ahead of #2`);
		return parts.join(' · ');
	}
	const streak = /^streak_(\d+)_years$/.exec(type);
	if (streak) {
		const n = Number(streak[1]);
		return c.streak_start_year != null
			? `${n} consecutive years from ${c.streak_start_year} to ${Number(c.streak_start_year) + n - 1}`
			: `${n} consecutive years (longest run ${s(c.longest_streak_years, String(n))})`;
	}
	if (/^plays_\d+_in_day$/.test(type)) return `${s(c.plays_that_day)} plays on ${s(c.window)}`;
	if (type === 'dominant' || type === 'sovereign') {
		const won = Array.isArray(c.months_won) ? (c.months_won as string[]) : [];
		return won.length ? `#1 track of ${won.length} months: ${won.join(', ')}` : 'multiple monthly #1s';
	}
	if (type.startsWith('artist_plays_')) return `${s(c.total_plays)} cumulative plays · ${s(c.distinct_tracks_played)} tracks`;
	if (type.startsWith('artist_tracks_')) return `${s(c.distinct_tracks)} distinct tracks · ${s(c.cumulative_plays)} plays`;
	if (type.startsWith('artist_streak_')) {
		return c.streak_start_year != null
			? `${s(c.consecutive_years)} consecutive years from ${c.streak_start_year}`
			: `${s(c.consecutive_years)} consecutive years`;
	}
	if (type === 'dynasty') {
		const tracks = Array.isArray(c.tracks_in_alltime_top_100) ? (c.tracks_in_alltime_top_100 as string[]) : [];
		return `${s(c.count)} tracks in the all-time Top 100${tracks.length ? `: ${tracks.join(', ')}` : ''}`;
	}
	if (type === 'rediscovery') return `${s(c.plays)} plays in ${s(c.window)} (dormant since ${s(c.last_active)})`;
	if (type === 'played_on_day_one') return `Heard it on release day (${s(c.release_date)})`;
	if (type === 'day_one_fan') return `${s(c.plays_on_release_day)} plays on release day (${s(c.release_date)})`;
	if (type === 'release_week_fan') return `${s(c.plays_in_release_week)} plays in release week (from ${s(c.release_date)})`;
	if (type === 'late_bloomer') {
		const gap = typeof c.gap_days === 'number' ? `${(c.gap_days / 365.25).toFixed(1)} years after release` : 'long after release';
		return `First played ${s(c.first_played)} (${gap}) · ${s(c.plays_within_90d_of_first_play)} plays in first 90 days`;
	}
	if (type === 'comeback') {
		const since = typeof c.dormant_since === 'string' ? c.dormant_since : null;
		const gap = since && typeof c.window === 'string' ? monthsBetween(since, c.window) : null;
		const silent = gap !== null ? gap - 1 : null;
		return silent !== null && silent > 0
			? `${s(c.plays_that_month)} plays in ${s(c.window)} after ${silent}-month dormancy`
			: `${s(c.plays_that_month)} plays in ${s(c.window)} (comeback)`;
	}
	if (type === 'season_regular') {
		const seasons = Array.isArray(c.seasons_qualified) ? (c.seasons_qualified as string[]) : [];
		return `Top 25 in ${s(c.count)} seasons${seasons.length ? `: ${seasons.join(', ')}` : ''}`;
	}
	if (type === 'multi_top') return `In ${s(c.count)} Top playlists simultaneously`;
	return JSON.stringify(c);
}

// ── Detail-page link helpers ─────────────────────────────────────────────────

export const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
export const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

export function trackHref(uri: string | null | undefined): string | null {
	return uri && TRACK_URI.test(uri) ? `/track/${encodeURIComponent(uri)}` : null;
}
export function artistHref(id: string | null | undefined): string | null {
	return id && SPOTIFY_ID.test(id) ? `/artist/${id}` : null;
}
export function albumHref(id: string | null | undefined): string | null {
	return id && SPOTIFY_ID.test(id) ? `/album/${id}` : null;
}
export function artistIdFromUri(uri: string | null | undefined): string | null {
	const m = /^spotify:artist:([A-Za-z0-9]{22})$/.exec(uri ?? '');
	return m ? m[1]! : null;
}

export const STATS_SECTIONS = [
	{ key: 'overview', href: '/stats', label: 'Overview' },
	{ key: 'top', href: '/stats/top', label: 'Top' },
	{ key: 'patterns', href: '/stats/patterns', label: 'Patterns' },
	{ key: 'year', href: '/stats/year', label: 'Year in review' },
	{ key: 'wrapped', href: '/stats/wrapped', label: 'Wrapped' },
	{ key: 'records', href: '/stats/records', label: 'Records' },
	{ key: 'behaviour', href: '/stats/behaviour', label: 'Behaviour' },
	{ key: 'compare', href: '/stats/compare', label: 'Compare' },
	{ key: 'badges', href: '/stats/badges', label: 'Badges' },
	{ key: 'onthisday', href: '/stats/onthisday', label: 'On this day' }
] as const;
export type StatsSection = (typeof STATS_SECTIONS)[number]['key'];
