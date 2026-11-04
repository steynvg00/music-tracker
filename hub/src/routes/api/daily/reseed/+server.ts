import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { requestReseed } from '$lib/server/daily';
import { isIsoDate } from '$lib/server/time';
import { apiError, readJson, toResponse } from '$lib/server/http';

/** POST /api/daily/reseed { date } — "Shuffle the deck". */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	if (!isIsoDate(b.date)) return apiError(400, { error: 'bad_request' });
	try {
		return json(await requestReseed(db(), config(), b.date));
	} catch (e) {
		return toResponse(e);
	}
};
