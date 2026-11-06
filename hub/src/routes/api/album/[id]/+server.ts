import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError } from '$lib/server/http';
import { albumDetail } from '$lib/server/stats/detail';
import { statsResponse } from '$lib/server/stats/http';
import { SPOTIFY_ID } from '$lib/shared/stats';

/** GET /api/album/{id} — Album detail (canonical-aware track list). */
export const GET: RequestHandler = async ({ params, request }) => {
	const id = params.id ?? '';
	if (!SPOTIFY_ID.test(id)) return apiError(404, { error: 'not_found' });
	const sql = db();
	return statsResponse(sql, request, `album|${id}`, () => albumDetail(sql, id));
};
