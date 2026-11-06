/**
 * Stats › Year in review, Records, Behaviour, Compare, Badges (R3). Same definitions as
 * views/stats.py; texts (artist/track) are grouped like Streamlit's unified_plays queries.
 */
import type { Queryable } from '$lib/server/db';
import { MILESTONES, type BadgeEvent, type SeriesPoint } from '$lib/shared/stats';

const day = (v: Date | string | null | undefined): string | null =>
	v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

// ── Year in review ───────────────────────────────────────────────────────────

export interface PeriodSummary {
	plays: number;
	uniqueTracks: number;
	uniqueArtists: number;
	days: number;
}

export interface YearReview {
	years: number[];
	year: number;
	current: PeriodSummary;
	previous: PeriodSummary;
	topTracks: { artist: string; track: string; uri: string | null; plays: number }[];
	topArtists: { artist: string; plays: number }[];
	monthly: SeriesPoint[];
	newArtists: number;
	biggestMonth: { month: string; plays: number } | null;
}

/** Plays / unique tracks / unique artists / listening days between two local dates (inclusive). */
export async function periodSummary(sql: Queryable, start: string, end: string): Promise<PeriodSummary> {
	const [r] = await sql<{ plays: number; tracks: number; artists: number; days: number }[]>`
		SELECT coalesce(sum(plays), 0)::int AS plays,
		       count(DISTINCT (artist || '|||' || track))::int AS tracks,
		       count(DISTINCT artist)::int AS artists,
		       count(DISTINCT d)::int AS days
		FROM hub.day_track WHERE d >= ${start}::date AND d <= ${end}::date`;
	return { plays: r?.plays ?? 0, uniqueTracks: r?.tracks ?? 0, uniqueArtists: r?.artists ?? 0, days: r?.days ?? 0 };
}

export async function yearReview(sql: Queryable, year: number | null): Promise<YearReview> {
	// Streamlit: years with at least 30 listening days.
	const ys = await sql<{ y: number }[]>`
		SELECT extract(year FROM d)::int AS y FROM hub.daily_listening GROUP BY 1 HAVING count(*) >= 30 ORDER BY 1 DESC`;
	const years = ys.map((r) => r.y);
	const y = year && years.includes(year) ? year : (years[0] ?? new Date().getUTCFullYear());
	const [current, previous, tracks, artists, monthly, [na]] = await Promise.all([
		periodSummary(sql, `${y}-01-01`, `${y}-12-31`),
		periodSummary(sql, `${y - 1}-01-01`, `${y - 1}-12-31`),
		sql<{ artist: string; track: string; uri: string | null; plays: number }[]>`
			SELECT artist, track, min(track_uri) AS uri, sum(plays)::int AS plays
			FROM hub.day_track WHERE d >= make_date(${y}, 1, 1) AND d < make_date(${y} + 1, 1, 1)
			GROUP BY artist, track ORDER BY plays DESC, artist, track LIMIT 10`,
		sql<{ artist: string; plays: number }[]>`
			SELECT artist, sum(plays)::int AS plays
			FROM hub.day_track WHERE d >= make_date(${y}, 1, 1) AND d < make_date(${y} + 1, 1, 1)
			GROUP BY artist ORDER BY plays DESC, artist LIMIT 10`,
		sql<{ m: string; plays: number }[]>`
			SELECT to_char(d, 'YYYY-MM') AS m, sum(plays)::int AS plays FROM hub.daily_listening
			WHERE d >= make_date(${y}, 1, 1) AND d < make_date(${y} + 1, 1, 1) GROUP BY 1 ORDER BY 1`,
		sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM hub.mv_artist_first WHERE extract(year FROM first_d) = ${y}`
	]);
	const biggest = monthly.reduce<{ m: string; plays: number } | null>((b, r) => (!b || r.plays > b.plays ? r : b), null);
	return {
		years,
		year: y,
		current,
		previous,
		topTracks: tracks,
		topArtists: artists,
		monthly: monthly.map((r) => ({ x: r.m, y: r.plays })),
		newArtists: na?.n ?? 0,
		biggestMonth: biggest ? { month: biggest.m, plays: biggest.plays } : null
	};
}

// ── Records ──────────────────────────────────────────────────────────────────

export interface Records {
	biggestDay: { day: string; plays: number; top: { track: string; artist: string; plays: number }[] } | null;
	longestGap: { lastBefore: { at: string; artist: string; track: string }; firstAfter: { at: string; artist: string; track: string }; ms: number } | null;
	milestones: { n: number; at: string; artist: string; track: string }[];
	topArtistPerYear: { year: number; artist: string; plays: number }[];
	achievements: {
		firstPlay: string | null;
		longestStreak: { len: number; start: string; end: string } | null;
		topArtist: { name: string; plays: number } | null;
		topTrack: { artist: string; track: string; plays: number } | null;
		biggestYear: { year: number; plays: number } | null;
		bestDiscoveryYear: { year: number; artists: number } | null;
		peakHour: { hour: number; plays: number } | null;
	};
}

export async function records(sql: Queryable): Promise<Records> {
	const [[bd], [gap], perYear, [first], [streak], [ta], [tt], [by], [bdy], [ph]] = await Promise.all([
		sql<{ d: Date; plays: number }[]>`SELECT d, plays FROM hub.daily_listening ORDER BY plays DESC, d LIMIT 1`,
		// Longest silence between two consecutive plays (Streamlit: LAG over unified_plays).
		sql<{ played_at: Date; artist: string | null; track: string | null; prev_played: Date; prev_artist: string | null; prev_track: string | null; gap_ms: string }[]>`
			WITH gaps AS (
				SELECT played_at, artist_name AS artist, track_name AS track,
				       lag(played_at) OVER (ORDER BY played_at) AS prev_played,
				       lag(artist_name) OVER (ORDER BY played_at) AS prev_artist,
				       lag(track_name) OVER (ORDER BY played_at) AS prev_track
				FROM spotify_plays WHERE track_uri IS NOT NULL
			)
			SELECT played_at, artist, track, prev_played, prev_artist, prev_track,
			       (extract(epoch FROM played_at - prev_played) * 1000)::bigint AS gap_ms
			FROM gaps WHERE prev_played IS NOT NULL ORDER BY played_at - prev_played DESC LIMIT 1`,
		sql<{ y: number; artist: string; plays: number }[]>`
			WITH yearly AS (
				SELECT extract(year FROM d)::int AS y, artist, sum(plays)::int AS plays,
				       row_number() OVER (PARTITION BY extract(year FROM d)::int ORDER BY sum(plays) DESC, artist) AS rnk
				FROM hub.day_track GROUP BY 1, 2
			)
			SELECT y, artist, plays FROM yearly WHERE rnk = 1 ORDER BY y DESC`,
		sql<{ first_d: Date | null }[]>`SELECT first_d FROM hub.mv_totals`,
		sql<{ len: number; start_d: Date; end_d: Date }[]>`
			WITH g AS (SELECT d, d - (row_number() OVER (ORDER BY d))::int AS grp FROM hub.daily_listening)
			SELECT count(*)::int AS len, min(d) AS start_d, max(d) AS end_d FROM g GROUP BY grp ORDER BY len DESC, start_d DESC LIMIT 1`,
		sql<{ artist: string; plays: number }[]>`SELECT artist, plays FROM hub.mv_artist_first ORDER BY plays DESC, artist LIMIT 1`,
		sql<{ artist: string; track: string; plays: number }[]>`
			SELECT artist, track, sum(plays)::int AS plays FROM hub.day_track GROUP BY 1, 2 ORDER BY plays DESC, artist, track LIMIT 1`,
		sql<{ y: number; plays: number }[]>`
			SELECT extract(year FROM d)::int AS y, sum(plays)::int AS plays FROM hub.daily_listening GROUP BY 1 ORDER BY plays DESC LIMIT 1`,
		sql<{ y: number; artists: number }[]>`
			SELECT extract(year FROM first_d)::int AS y, count(*)::int AS artists FROM hub.mv_artist_first GROUP BY 1 ORDER BY artists DESC, y LIMIT 1`,
		sql<{ hour: number; plays: number }[]>`
			SELECT hour, sum(plays)::int AS plays FROM hub.mv_hour_dow GROUP BY hour ORDER BY plays DESC, hour LIMIT 1`
	]);
	const topDay = bd
		? await sql<{ track: string; artist: string; plays: number }[]>`
			SELECT track, artist, sum(plays)::int AS plays FROM hub.day_track WHERE d = ${day(bd.d)}::date
			GROUP BY track, artist ORDER BY plays DESC, artist, track LIMIT 5`
		: [];
	return {
		biggestDay: bd ? { day: day(bd.d)!, plays: bd.plays, top: topDay } : null,
		longestGap: gap
			? {
					lastBefore: { at: iso(gap.prev_played)!, artist: gap.prev_artist ?? '', track: gap.prev_track ?? '' },
					firstAfter: { at: iso(gap.played_at)!, artist: gap.artist ?? '', track: gap.track ?? '' },
					ms: Number(gap.gap_ms)
				}
			: null,
		milestones: await milestones(sql),
		topArtistPerYear: perYear.map((r) => ({ year: r.y, artist: r.artist, plays: r.plays })),
		achievements: {
			firstPlay: day(first?.first_d),
			longestStreak: streak ? { len: streak.len, start: day(streak.start_d)!, end: day(streak.end_d)! } : null,
			topArtist: ta ? { name: ta.artist, plays: ta.plays } : null,
			topTrack: tt ?? null,
			biggestYear: by ? { year: by.y, plays: by.plays } : null,
			bestDiscoveryYear: bdy ? { year: bdy.y, artists: bdy.artists } : null,
			peakHour: ph ?? null
		}
	};
}

/**
 * The Nth play ever, for each milestone N (Streamlit: ROW_NUMBER over unified_plays).
 * Cheap version: find each milestone's day from cumulative daily sums, then OFFSET into
 * that day's plays (index on played_at) instead of numbering 420k rows.
 */
export async function milestones(sql: Queryable): Promise<Records['milestones']> {
	const days = await sql<{ d: Date; before: string; plays: number }[]>`
		SELECT d, (sum(plays) OVER (ORDER BY d) - plays)::bigint AS before, plays FROM hub.daily_listening ORDER BY d`;
	const out: Records['milestones'] = [];
	for (const m of MILESTONES) {
		const hit = days.find((r) => Number(r.before) < m && Number(r.before) + r.plays >= m);
		if (!hit) continue;
		const offset = m - Number(hit.before) - 1;
		const d = day(hit.d)!;
		const [p] = await sql<{ played_at: Date; artist: string | null; track: string | null }[]>`
			SELECT played_at, artist_name AS artist, track_name AS track FROM spotify_plays
			WHERE track_uri IS NOT NULL
			  AND played_at >= (${d}::date::timestamp AT TIME ZONE 'Europe/Amsterdam')
			  AND played_at < ((${d}::date + 1)::timestamp AT TIME ZONE 'Europe/Amsterdam')
			ORDER BY played_at, id OFFSET ${offset} LIMIT 1`;
		if (p) out.push({ n: m, at: iso(p.played_at)!, artist: p.artist ?? '', track: p.track ?? '' });
	}
	return out;
}

// ── Behaviour (Streamlit "Spotify" tab) ──────────────────────────────────────

export interface Behaviour {
	overview: { plays: number; hours: number; firstDay: string | null; lastDay: string | null; distinctTracks: number };
	hoursByYear: { year: number; hours: number }[];
	skipRatePct: number;
	mostSkipped: { uri: string; track: string; artist: string; plays: number; skips: number; skipRatePct: number }[];
	platforms: { family: string; plays: number; pct: number }[];
	shuffleRatePct: number;
	shuffleByYear: { year: number; pct: number }[];
	endReasons: { reason: string; plays: number; pct: number }[];
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);

export async function behaviour(sql: Queryable): Promise<Behaviour> {
	const [[ov], [dt], years, [skip], skipped, platforms, shuffleYears, reasons] = await Promise.all([
		sql<{ plays: number; ms: string; first_d: Date | null; last_d: Date | null }[]>`
			SELECT coalesce(sum(plays), 0)::int AS plays, coalesce(sum(ms), 0)::bigint AS ms, min(d) AS first_d, max(d) AS last_d FROM hub.behaviour_daily`,
		sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hub.mv_track_stats`,
		sql<{ y: number; ms: string }[]>`
			SELECT extract(year FROM d)::int AS y, sum(ms)::bigint AS ms FROM hub.behaviour_daily GROUP BY 1 ORDER BY 1`,
		sql<{ skips: number; plays: number; shuffles: number }[]>`
			SELECT (sum(plays) FILTER (WHERE reason_end = 'fwdbtn'))::int AS skips, sum(plays)::int AS plays,
			       (sum(plays) FILTER (WHERE shuffle = 1))::int AS shuffles
			FROM hub.behaviour_daily`,
		sql<{ uri: string; track: string; artist: string; plays: number; skips: number; rate: string }[]>`
			SELECT track_uri AS uri, track_name AS track, artist_name AS artist, plays, skips,
			       round(100.0 * skips / plays, 1) AS rate
			FROM hub.mv_track_stats WHERE plays >= 10 AND skips > 0
			ORDER BY rate DESC, skips DESC, track_uri LIMIT 20`,
		sql<{ family: string; plays: number }[]>`
			SELECT platform_family AS family, sum(plays)::int AS plays FROM hub.behaviour_daily GROUP BY 1 ORDER BY plays DESC, family`,
		sql<{ y: number; on: number; total: number }[]>`
			SELECT extract(year FROM d)::int AS y, (sum(plays) FILTER (WHERE shuffle = 1))::int AS on, sum(plays)::int AS total
			FROM hub.behaviour_daily GROUP BY 1 ORDER BY 1`,
		sql<{ reason: string; plays: number }[]>`
			SELECT reason_end AS reason, sum(plays)::int AS plays FROM hub.behaviour_daily GROUP BY 1 ORDER BY plays DESC, reason`
	]);
	const total = ov?.plays ?? 0;
	const reasonTotal = reasons.filter((r) => r.reason !== '').reduce((a, r) => a + r.plays, 0);
	return {
		overview: {
			plays: total,
			hours: Math.round((Number(ov?.ms ?? 0) / 3_600_000) * 10) / 10,
			firstDay: day(ov?.first_d),
			lastDay: day(ov?.last_d),
			distinctTracks: dt?.n ?? 0
		},
		hoursByYear: years.map((r) => ({ year: r.y, hours: Math.round((Number(r.ms) / 3_600_000) * 10) / 10 })),
		skipRatePct: pct(skip?.skips ?? 0, skip?.plays ?? 0),
		mostSkipped: skipped.map((r) => ({ uri: r.uri, track: r.track, artist: r.artist, plays: r.plays, skips: r.skips, skipRatePct: Number(r.rate) })),
		platforms: platforms.map((r) => ({ family: r.family, plays: r.plays, pct: pct(r.plays, total) })),
		shuffleRatePct: pct(skip?.shuffles ?? 0, skip?.plays ?? 0),
		shuffleByYear: shuffleYears.map((r) => ({ year: r.y, pct: pct(r.on ?? 0, r.total) })),
		endReasons: reasons.filter((r) => r.reason !== '').map((r) => ({ reason: r.reason, plays: r.plays, pct: pct(r.plays, reasonTotal) }))
	};
}

// ── Compare ──────────────────────────────────────────────────────────────────

export type CompareMode = 'year' | 'month';

export function periodBounds(mode: CompareMode, key: string): { start: string; end: string } | null {
	if (mode === 'year' && /^\d{4}$/.test(key)) return { start: `${key}-01-01`, end: `${key}-12-31` };
	const m = /^(\d{4})-(\d{2})$/.exec(key);
	if (mode === 'month' && m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
		const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
		return { start: `${key}-01`, end: `${key}-${String(last).padStart(2, '0')}` };
	}
	return null;
}

export async function comparePeriods(sql: Queryable, mode: CompareMode, a: string | null, b: string | null) {
	const opts =
		mode === 'year'
			? (await sql<{ k: string }[]>`SELECT DISTINCT extract(year FROM d)::int::text AS k FROM hub.daily_listening ORDER BY 1 DESC`).map((r) => r.k)
			: (await sql<{ k: string }[]>`SELECT DISTINCT to_char(d, 'YYYY-MM') AS k FROM hub.daily_listening ORDER BY 1 DESC`).map((r) => r.k);
	const ka = a && opts.includes(a) ? a : (opts[0] ?? null);
	const kb = b && opts.includes(b) ? b : (opts[1] ?? opts[0] ?? null);
	const ba = ka ? periodBounds(mode, ka) : null;
	const bb = kb ? periodBounds(mode, kb) : null;
	const [sa, sb] = await Promise.all([
		ba ? periodSummary(sql, ba.start, ba.end) : Promise.resolve(null),
		bb ? periodSummary(sql, bb.start, bb.end) : Promise.resolve(null)
	]);
	return { mode, options: opts, a: ka, b: kb, summaryA: sa, summaryB: sb };
}

/** Artist battle (Streamlit Deep dives): cumulative monthly plays of two artists (artist text). */
export async function artistBattle(sql: Queryable, a: string, b: string) {
	const rows = await sql<{ artist: string; m: string; plays: number }[]>`
		SELECT artist, to_char(d, 'YYYY-MM') AS m, sum(plays)::int AS plays
		FROM hub.day_track WHERE artist IN (${a}, ${b}) GROUP BY 1, 2 ORDER BY 1, 2`;
	const months = [...new Set(rows.map((r) => r.m))].sort();
	const series = [a, b].map((name) => {
		let acc = 0;
		return {
			name,
			plays: rows.filter((r) => r.artist === name).reduce((t, r) => t + r.plays, 0),
			firstMonth: rows.find((r) => r.artist === name)?.m ?? null,
			cumulative: months.map((m) => (acc += rows.find((r) => r.artist === name && r.m === m)?.plays ?? 0))
		};
	});
	return { months, series };
}

export async function topArtistNames(sql: Queryable, limit = 200): Promise<string[]> {
	const rows = await sql<{ artist: string }[]>`
		SELECT artist FROM hub.mv_artist_first WHERE artist <> '' ORDER BY plays DESC, artist LIMIT ${limit}`;
	return rows.map((r) => r.artist);
}

// ── Badges ───────────────────────────────────────────────────────────────────

interface BadgeRow {
	entity_type: 'track' | 'artist';
	entity_id: string;
	badge_type: string;
	awarded_at: Date;
	context: Record<string, unknown> | null;
	name: string | null;
	artist: string | null;
}

export function toBadgeEvent(r: BadgeRow): BadgeEvent {
	return {
		entityType: r.entity_type,
		entityId: r.entity_id,
		badgeType: r.badge_type,
		awardedAt: new Date(r.awarded_at).toISOString(),
		context: r.context ?? {},
		name: r.name,
		artist: r.artist
	};
}

export async function badgesOverview(sql: Queryable) {
	const [counts, recent] = await Promise.all([
		sql<{ entity_type: 'track' | 'artist'; badge_type: string; n: number; entities: number }[]>`
			SELECT entity_type, badge_type, count(*)::int AS n, count(DISTINCT entity_id)::int AS entities
			FROM badge_events GROUP BY 1, 2 ORDER BY 1, 2`,
		sql<BadgeRow[]>`
			SELECT be.entity_type, be.entity_id, be.badge_type, be.awarded_at, be.context,
			       CASE WHEN be.entity_type = 'track' THEN ts.track_name ELSE ast.artist_name END AS name,
			       CASE WHEN be.entity_type = 'track' THEN ts.artist_name END AS artist
			FROM badge_events be
			LEFT JOIN hub.mv_track_stats ts ON be.entity_type = 'track' AND ts.track_uri = be.entity_id
			LEFT JOIN hub.mv_artist_stats ast ON be.entity_type = 'artist' AND ast.artist_id = be.entity_id
			ORDER BY be.awarded_at DESC, be.id DESC LIMIT 60`
	]);
	return {
		counts: counts.map((r) => ({ entityType: r.entity_type, badgeType: r.badge_type, count: r.n, entities: r.entities })),
		recent: recent.map(toBadgeEvent)
	};
}
