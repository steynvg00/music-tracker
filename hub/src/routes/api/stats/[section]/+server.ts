import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError } from '$lib/server/http';
import { localDate } from '$lib/server/time';
import { albumDepth, artistRace, onThisDay, overview, patterns, topArtists, topTracks } from '$lib/server/stats/core';
import { artistBattle, badgesOverview, behaviour, comparePeriods, records, topArtistNames, yearReview } from '$lib/server/stats/sections';
import { statsResponse } from '$lib/server/stats/http';
import { isArtistRank, isTrackRank, parseRange } from '$lib/shared/stats';

const year = (v: string | null): number | null => (v && /^\d{4}$/.test(v) ? Number(v) : null);

/**
 * GET /api/stats/{section} — Stats screens (R3). Sections: overview, top, patterns, year,
 * records, behaviour, compare, badges, onthisday. Cached 30 s + ETag on the rollup refresh.
 */
export const GET: RequestHandler = async ({ params, url, request }) => {
	const sql = db();
	const today = localDate();
	const q = url.searchParams;
	const key = `${params.section}|${today}|${url.search}`;
	switch (params.section) {
		case 'overview':
			return statsResponse(sql, request, key, () => overview(sql, today));
		case 'top': {
			const range = parseRange(q.get('range'), today);
			const view = q.get('view') ?? 'tracks';
			if (view === 'artists') {
				const rank = isArtistRank(q.get('rank')) ? (q.get('rank') as Parameters<typeof topArtists>[2]) : 'plays';
				return statsResponse(sql, request, key, async () => ({ view, range, rank, artists: await topArtists(sql, range, rank) }));
			}
			if (view === 'albums') {
				const mode = q.get('mode') === 'depth' ? 'depth' : 'plays';
				return statsResponse(sql, request, key, async () => ({ view, range, mode, albums: await albumDepth(sql, mode) }));
			}
			if (view === 'race') return statsResponse(sql, request, key, async () => ({ view, range, race: await artistRace(sql) }));
			const rank = isTrackRank(q.get('rank')) ? (q.get('rank') as Parameters<typeof topTracks>[2]) : 'plays';
			return statsResponse(sql, request, key, async () => ({ view: 'tracks', range, rank, tracks: await topTracks(sql, range, rank) }));
		}
		case 'patterns':
			return statsResponse(sql, request, key, () => patterns(sql, year(q.get('year'))));
		case 'year':
			return statsResponse(sql, request, key, () => yearReview(sql, year(q.get('year'))));
		case 'records':
			return statsResponse(sql, request, key, () => records(sql));
		case 'behaviour':
			return statsResponse(sql, request, key, () => behaviour(sql));
		case 'compare': {
			const mode = q.get('mode') === 'month' ? 'month' : 'year';
			return statsResponse(sql, request, key, async () => {
				const periods = await comparePeriods(sql, mode, q.get('a'), q.get('b'));
				const names = await topArtistNames(sql);
				const aa = q.get('artistA') && names.includes(q.get('artistA')!) ? q.get('artistA')! : (names[0] ?? null);
				const ab = q.get('artistB') && names.includes(q.get('artistB')!) ? q.get('artistB')! : (names[1] ?? null);
				return { ...periods, artists: names, artistA: aa, artistB: ab, battle: aa && ab ? await artistBattle(sql, aa, ab) : null };
			});
		}
		case 'badges':
			return statsResponse(sql, request, key, () => badgesOverview(sql));
		case 'onthisday': {
			const d = q.get('date');
			const date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : today;
			return statsResponse(sql, request, key, async () => ({ date, years: await onThisDay(sql, date) }));
		}
		default:
			return apiError(404, { error: 'not_found', message: 'Unknown stats section' });
	}
};
