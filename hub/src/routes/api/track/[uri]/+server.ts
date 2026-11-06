import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError } from '$lib/server/http';
import { trackDetail } from '$lib/server/stats/detail';
import { statsResponse } from '$lib/server/stats/http';
import { TRACK_URI } from '$lib/shared/stats';

/** GET /api/track/{spotify:track:…} — Track detail: your history with this recording (all URI variants). */
export const GET: RequestHandler = async ({ params, request }) => {
	const uri = decodeURIComponent(params.uri ?? '');
	if (!TRACK_URI.test(uri)) return apiError(404, { error: 'not_found' });
	const sql = db();
	return statsResponse(sql, request, `track|${uri}`, () => trackDetail(sql, uri));
};
