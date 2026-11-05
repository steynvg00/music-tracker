import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError } from '$lib/server/http';
import { artistDetail } from '$lib/server/stats/detail';
import { statsResponse } from '$lib/server/stats/http';
import { SPOTIFY_ID } from '$lib/shared/stats';

/** GET /api/artist/{id} — Artist detail (every track crediting this artist). */
export const GET: RequestHandler = async ({ params, request }) => {
	const id = params.id ?? '';
	if (!SPOTIFY_ID.test(id)) return apiError(404, { error: 'not_found' });
	const sql = db();
	return statsResponse(sql, request, `artist|${id}`, () => artistDetail(sql, id));
};
