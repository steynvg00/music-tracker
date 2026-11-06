/**
 * Stats › Overview, Top, Patterns, On this day (R3). Ported from views/stats.py with the same
 * populations and definitions; the heavy parts read the hub.* rollups (migration 0023).
 * Every function takes a Queryable so tests can pass a fake.
 */
import type { Queryable } from '$lib/server/db';
import {
	ARTIST_RANKS,
	TRACK_RANKS,
	heatmapGrid,
	type ArtistRank,
	type RankedAlbum,
	type RankedArtist,
	type RankedTrack,
	type SeriesPoint,
	type StatsRange,
	type TrackRank
} from '$lib/shared/stats';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const day = (v: Date | string | null | undefined): string | null =>
	v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

// ── Overview ─────────────────────────────────────────────────────────────────

export interface Overview {
	totals: { plays: number; uniqueTracks: number; uniqueArtists: number; firstDay: string | null; lastDay: string | null; hours: number };
	streaks: { daysListening: number; current: number; longest: number; avgPerDay: number };
	monthly: SeriesPoint[];
	discovery: { month: string; artists: number; tracks: number }[];
	fingerprint: { peakHour: number | null; peakWeekday: number | null; avgPerListeningDay: number; listeningDays: number };
	refreshedAt: string | null;
}

/** Run-length streaks over sorted distinct days (same SQL idea as Streamlit's gaps-and-islands). */
export function streaksFrom(days: string[], today: string): { current: number; longest: number } {
	let longest = 0;
	let current = 0;
	let run = 0;
	let prev: number | null = null;
	let lastEnd: number | null = null;
	for (const d of days) {
		const t = Date.parse(`${d}T00:00:00Z`) / 86_400_000;
		run = prev !== null && t === prev + 1 ? run + 1 : 1;
		prev = t;
		lastEnd = t;
		if (run > longest) longest = run;
	}
	const todayN = Date.parse(`${today}T00:00:00Z`) / 86_400_000;
	if (lastEnd !== null && lastEnd >= todayN - 1) current = run;
	return { current, longest };
}

export async function overview(sql: Queryable, today: string): Promise<Overview> {
	const [[t], days, monthly, disc, fp, [state]] = await Promise.all([
		sql<{ plays: string; unique_tracks: number; unique_artists: number; days: number; first_d: Date | null; last_d: Date | null; ms: string }[]>`
			SELECT plays, unique_tracks, unique_artists, days, first_d, last_d, ms FROM hub.mv_totals`,
		sql<{ d: Date }[]>`SELECT d FROM hub.daily_listening ORDER BY d`,
		sql<{ m: string; plays: number }[]>`
			SELECT to_char(d, 'YYYY-MM') AS m, sum(plays)::int AS plays FROM hub.daily_listening GROUP BY 1 ORDER BY 1`,
		sql<{ m: string; artists: number; tracks: number }[]>`
			WITH a AS (SELECT to_char(first_d, 'YYYY-MM') AS m, count(*)::int AS n FROM hub.mv_artist_first GROUP BY 1),
			     t AS (SELECT to_char(first_d, 'YYYY-MM') AS m, count(*)::int AS n FROM hub.mv_track_first GROUP BY 1)
			SELECT coalesce(a.m, t.m) AS m, coalesce(a.n, 0) AS artists, coalesce(t.n, 0) AS tracks
			FROM a FULL JOIN t ON t.m = a.m ORDER BY 1`,
		sql<{ kind: string; k: number }[]>`
			(SELECT 'hour' AS kind, hour AS k FROM hub.mv_hour_dow GROUP BY hour ORDER BY sum(plays) DESC, hour LIMIT 1)
			UNION ALL
			(SELECT 'dow' AS kind, dow AS k FROM hub.mv_hour_dow GROUP BY dow ORDER BY sum(plays) DESC, dow LIMIT 1)`,
		sql<{ refreshed_at: Date | null }[]>`SELECT refreshed_at FROM hub.rollup_state`
	]);
	const plays = n(t?.plays);
	const listening = n(t?.days);
	const s = streaksFrom(
		days.map((r) => day(r.d)!),
		today
	);
	return {
		totals: {
			plays,
			uniqueTracks: n(t?.unique_tracks),
			uniqueArtists: n(t?.unique_artists),
			firstDay: day(t?.first_d),
			lastDay: day(t?.last_d),
			hours: Math.round((n(t?.ms) / 3_600_000) * 10) / 10
		},
		// Streamlit: avg = int(total / days)
		streaks: { daysListening: listening, current: s.current, longest: s.longest, avgPerDay: listening ? Math.floor(plays / listening) : 0 },
		monthly: monthly.map((r) => ({ x: r.m, y: r.plays })),
		discovery: disc.map((r) => ({ month: r.m, artists: r.artists, tracks: r.tracks })),
		fingerprint: {
			peakHour: fp.find((r) => r.kind === 'hour')?.k ?? null,
			peakWeekday: fp.find((r) => r.kind === 'dow')?.k ?? null,
			avgPerListeningDay: listening ? Math.round((plays / listening) * 10) / 10 : 0,
			listeningDays: listening
		},
		refreshedAt: state?.refreshed_at ? new Date(state.refreshed_at).toISOString() : null
	};
}

// ── Top ──────────────────────────────────────────────────────────────────────

/** Streamlit's date filter: played_at >= start AND < end + 1 day (dates in the session time zone). */
export async function topTracks(sql: Queryable, range: StatsRange, rank: TrackRank, limit = 50): Promise<RankedTrack[]> {
	if (TRACK_RANKS[rank].column === null) {
		const rows = await sql<{ uri: string; plays: number; name: string | null; artist: string | null; artist_id: string | null }[]>`
			WITH plays_by_canonical AS (
				SELECT tm.canonical_track_uri AS track_uri, count(*)::int AS plays
				FROM spotify_plays sp
				JOIN track_metadata tm ON tm.track_uri = sp.track_uri
				WHERE sp.track_uri IS NOT NULL AND tm.canonical_track_uri IS NOT NULL
				  AND (${range.start}::date IS NULL OR (sp.played_at >= ${range.start}::date AND sp.played_at < ${range.end}::date + interval '1 day'))
				GROUP BY tm.canonical_track_uri
			)
			SELECT pbc.track_uri AS uri, pbc.plays, ts.track_name AS name,
			       array_to_string(tm_can.artist_names, ', ') AS artist, tm_can.artist_ids[1] AS artist_id
			FROM plays_by_canonical pbc
			JOIN track_metadata tm_can ON tm_can.track_uri = pbc.track_uri
			LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = pbc.track_uri
			ORDER BY pbc.plays DESC, ts.track_name, pbc.track_uri
			LIMIT ${limit}`;
		return rows.map((r, i) => ({ rank: i + 1, uri: r.uri, name: r.name ?? 'Unknown track', artist: r.artist ?? '', plays: r.plays, artistId: r.artist_id }));
	}
	const col = TRACK_RANKS[rank].column;
	const rows = await sql<{ uri: string; plays: number; score: string | null; name: string | null; artist: string | null; artist_id: string | null }[]>`
		SELECT s.track_uri AS uri, s.raw_plays AS plays,
		       (CASE ${col} WHEN 'composite_score' THEN s.composite_score WHEN 'sticky_pct' THEN s.sticky_pct
		                    WHEN 'evergreen_pct' THEN s.evergreen_pct WHEN 'flash_hit_pct' THEN s.flash_hit_pct
		                    ELSE s.session_loop_pct END) AS score,
		       ts.track_name AS name, array_to_string(tm_can.artist_names, ', ') AS artist, tm_can.artist_ids[1] AS artist_id
		FROM track_popularity_scores s
		JOIN track_metadata tm_can ON tm_can.track_uri = s.track_uri
		LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = s.track_uri
		WHERE (CASE ${col} WHEN 'composite_score' THEN s.composite_score WHEN 'sticky_pct' THEN s.sticky_pct
		                   WHEN 'evergreen_pct' THEN s.evergreen_pct WHEN 'flash_hit_pct' THEN s.flash_hit_pct
		                   ELSE s.session_loop_pct END) IS NOT NULL
		ORDER BY score DESC, s.track_uri
		LIMIT ${limit}`;
	return rows.map((r, i) => ({
		rank: i + 1,
		uri: r.uri,
		name: r.name ?? 'Unknown track',
		artist: r.artist ?? '',
		plays: r.plays,
		score: r.score === null ? null : Number(r.score),
		artistId: r.artist_id
	}));
}

export async function topArtists(sql: Queryable, range: StatsRange, rank: ArtistRank, limit = 50): Promise<RankedArtist[]> {
	if (ARTIST_RANKS[rank].column === null) {
		const rows = await sql<{ artist: string; plays: number; id: string | null }[]>`
			WITH plays_with_artists AS (
				SELECT u.name AS artist, u.id
				FROM spotify_plays sp
				JOIN track_metadata tm ON tm.track_uri = sp.track_uri
				CROSS JOIN LATERAL unnest(tm.artist_names, tm.artist_ids) AS u(name, id)
				WHERE sp.track_uri IS NOT NULL AND tm.artist_names IS NOT NULL AND array_length(tm.artist_names, 1) > 0
				  AND (${range.start}::date IS NULL OR (sp.played_at >= ${range.start}::date AND sp.played_at < ${range.end}::date + interval '1 day'))
			)
			SELECT artist, count(*)::int AS plays, min(id) AS id
			FROM plays_with_artists WHERE artist IS NOT NULL
			GROUP BY artist ORDER BY plays DESC, artist LIMIT ${limit}`;
		return rows.map((r, i) => ({ rank: i + 1, name: r.artist, id: r.id, plays: r.plays }));
	}
	const col = ARTIST_RANKS[rank].column;
	const rows = await sql<{ artist: string; plays: number; score: string | null; id: string | null }[]>`
		SELECT aps.artist_name AS artist, aps.total_plays AS plays,
		       (CASE ${col} WHEN 'composite_score' THEN aps.composite_score WHEN 'sticky_pct' THEN aps.sticky_pct
		                    WHEN 'evergreen_pct' THEN aps.evergreen_pct WHEN 'depth_pct' THEN aps.depth_pct
		                    ELSE aps.saved_count_pct END) AS score,
		       (SELECT ast.artist_id FROM hub.mv_artist_stats ast WHERE ast.artist_name = aps.artist_name ORDER BY ast.plays DESC LIMIT 1) AS id
		FROM artist_popularity_scores aps
		ORDER BY score DESC NULLS LAST, aps.artist_name
		LIMIT ${limit}`;
	return rows.map((r, i) => ({ rank: i + 1, name: r.artist, id: r.id, plays: r.plays, score: r.score === null ? null : Number(r.score) }));
}

/** Personality › Album depth: by total plays (Streamlit's first radio) or plays per track (≥ 3 tracks). */
export async function albumDepth(sql: Queryable, mode: 'plays' | 'depth'): Promise<RankedAlbum[]> {
	const rows =
		mode === 'plays'
			? await sql<{ album: string; artist: string; unique_tracks: number; plays: number; album_id: string | null }[]>`
				SELECT sp.album_name AS album, sp.artist_name AS artist, count(DISTINCT sp.track_name)::int AS unique_tracks,
				       count(*)::int AS plays, min(tm.album_id) AS album_id
				FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
				WHERE sp.track_uri IS NOT NULL AND sp.album_name IS NOT NULL AND sp.album_name <> ''
				GROUP BY sp.album_name, sp.artist_name
				ORDER BY plays DESC, unique_tracks DESC, album LIMIT 20`
			: await sql<{ album: string; artist: string; unique_tracks: number; plays: number; ppt: string; album_id: string | null }[]>`
				SELECT sp.album_name AS album, sp.artist_name AS artist, count(DISTINCT sp.track_uri)::int AS unique_tracks,
				       count(*)::int AS plays, round(count(*)::numeric / nullif(count(DISTINCT sp.track_uri), 0), 2) AS ppt,
				       min(tm.album_id) AS album_id
				FROM spotify_plays sp LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
				WHERE sp.album_name IS NOT NULL
				GROUP BY sp.album_name, sp.artist_name
				HAVING count(DISTINCT sp.track_uri) >= 3
				ORDER BY ppt DESC, album LIMIT 50`;
	return rows.map((r, i) => ({
		rank: i + 1,
		name: r.album,
		artist: r.artist ?? '',
		albumId: r.album_id,
		uniqueTracks: r.unique_tracks,
		plays: r.plays,
		...('ppt' in r ? { playsPerTrack: Number((r as { ppt: string }).ppt) } : {})
	}));
}

/** Top › Race: the 10 biggest artists overall, their rank in each year (Streamlit "Artist rank race"). */
export async function artistRace(sql: Queryable): Promise<{ years: number[]; artists: { name: string; ranks: (number | null)[]; plays: number[] }[] }> {
	const rows = await sql<{ y: number; artist: string; plays: number; rnk: number }[]>`
		WITH yearly AS (
			SELECT extract(year FROM d)::int AS y, artist, sum(plays)::int AS plays FROM hub.day_track GROUP BY 1, 2
		),
		ranked AS (SELECT y, artist, plays, row_number() OVER (PARTITION BY y ORDER BY plays DESC, artist)::int AS rnk FROM yearly),
		top10 AS (SELECT artist FROM yearly GROUP BY artist ORDER BY sum(plays) DESC, artist LIMIT 10)
		SELECT r.y, r.artist, r.plays, r.rnk FROM ranked r JOIN top10 t ON t.artist = r.artist ORDER BY r.y, r.rnk`;
	const years = [...new Set(rows.map((r) => r.y))].sort((a, b) => a - b);
	const names = [...new Set(rows.map((r) => r.artist))];
	return {
		years,
		artists: names.map((name) => ({
			name,
			ranks: years.map((y) => rows.find((r) => r.y === y && r.artist === name)?.rnk ?? null),
			plays: years.map((y) => rows.find((r) => r.y === y && r.artist === name)?.plays ?? 0)
		}))
	};
}

// ── Patterns ─────────────────────────────────────────────────────────────────

export interface Patterns {
	years: number[];
	year: number;
	daily: { d: string; plays: number }[];
	heatmap: number[][];
	weekend: RankedArtist[];
	weekday: RankedArtist[];
}

export async function patterns(sql: Queryable, year: number | null): Promise<Patterns> {
	const yearsRows = await sql<{ y: number }[]>`SELECT DISTINCT extract(year FROM d)::int AS y FROM hub.daily_listening ORDER BY y DESC`;
	const years = yearsRows.map((r) => r.y);
	const y = year && years.includes(year) ? year : (years[0] ?? new Date().getUTCFullYear());
	const [daily, hd, split] = await Promise.all([
		sql<{ d: Date; plays: number }[]>`
			SELECT d, plays FROM hub.daily_listening WHERE d >= make_date(${y}, 1, 1) AND d < make_date(${y} + 1, 1, 1) ORDER BY d`,
		sql<{ dow: number; hour: number; plays: number }[]>`SELECT dow, hour, plays FROM hub.mv_hour_dow`,
		sql<{ day_type: 'weekend' | 'weekday'; rnk: number; artist: string; plays: number }[]>`
			WITH plays_with_artists AS (
				SELECT unnest(tm.artist_names) AS artist,
				       CASE WHEN extract(dow FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam') IN (0, 6) THEN 'weekend' ELSE 'weekday' END AS day_type
				FROM spotify_plays sp JOIN track_metadata tm ON tm.track_uri = sp.track_uri
				WHERE sp.track_uri IS NOT NULL AND tm.artist_names IS NOT NULL
			),
			ranked AS (
				SELECT day_type, artist, count(*)::int AS plays,
				       row_number() OVER (PARTITION BY day_type ORDER BY count(*) DESC, artist)::int AS rnk
				FROM plays_with_artists GROUP BY day_type, artist
			)
			SELECT day_type, rnk, artist, plays FROM ranked WHERE rnk <= 10 ORDER BY day_type, rnk`
	]);
	const side = (t: 'weekend' | 'weekday') =>
		split.filter((r) => r.day_type === t).map((r) => ({ rank: r.rnk, name: r.artist, id: null, plays: r.plays }));
	return {
		years,
		year: y,
		daily: daily.map((r) => ({ d: day(r.d)!, plays: r.plays })),
		heatmap: heatmapGrid(hd),
		weekend: side('weekend'),
		weekday: side('weekday')
	};
}

// ── On this day (Stats page: every year incl. the current one, like the Streamlit tab) ──

export interface OnThisDayYear {
	year: number;
	plays: number;
	tracks: { artist: string; track: string; uri: string | null; plays: number }[];
}

export async function onThisDay(sql: Queryable, date: string): Promise<OnThisDayYear[]> {
	const rows = await sql<{ y: number; artist: string; track: string; track_uri: string | null; plays: number }[]>`
		SELECT extract(year FROM d)::int AS y, artist, track, track_uri, plays
		FROM hub.day_track
		WHERE (extract(month FROM d) * 100 + extract(day FROM d))::int
		      = (extract(month FROM ${date}::date) * 100 + extract(day FROM ${date}::date))::int
		  AND d <= ${date}::date
		ORDER BY y DESC, plays DESC, artist, track`;
	const out = new Map<number, OnThisDayYear>();
	for (const r of rows) {
		const e = out.get(r.y) ?? { year: r.y, plays: 0, tracks: [] };
		e.plays += r.plays;
		e.tracks.push({ artist: r.artist, track: r.track, uri: r.track_uri, plays: r.plays });
		out.set(r.y, e);
	}
	return [...out.values()];
}
