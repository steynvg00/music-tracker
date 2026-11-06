import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { search } from '$lib/server/stats/detail';
import { statsResponse } from '$lib/server/stats/http';

/** GET /api/search?q= — your tracks, artists, albums and playlists (never the Spotify catalogue). */
export const GET: RequestHandler = async ({ url, request }) => {
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const sql = db();
	return statsResponse(sql, request, `search|${q.toLowerCase()}`, () => search(sql, q));
};
