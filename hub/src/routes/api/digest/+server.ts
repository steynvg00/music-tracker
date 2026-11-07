import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { digestPayload } from '$lib/server/digest';
import { localDate } from '$lib/server/time';
import { toResponse } from '$lib/server/http';

/** GET /api/digest?week=YYYY-MM-DD (a Monday) — "This week", the Monday digest in-app (R8). */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const body = await digestPayload(db(), url.searchParams.get('week'), localDate());
		return json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });
	} catch (e) {
		return toResponse(e);
	}
};
