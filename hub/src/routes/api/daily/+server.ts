import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { loadDeck } from '$lib/server/daily';
import { isIsoDate, localDate } from '$lib/server/time';
import { apiError, toResponse } from '$lib/server/http';

/** GET /api/daily[?date=YYYY-MM-DD] — the day's deck + state. */
export const GET: RequestHandler = async ({ url }) => {
	const date = url.searchParams.get('date') ?? localDate();
	if (!isIsoDate(date)) return apiError(400, { error: 'bad_request', message: 'date must be YYYY-MM-DD' });
	try {
		return json(await loadDeck(db(), date, !!config().githubDispatchToken));
	} catch (e) {
		return toResponse(e);
	}
};
