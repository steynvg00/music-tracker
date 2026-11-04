import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { loadDeck, select } from '$lib/server/daily';
import { isIsoDate } from '$lib/server/time';
import { apiError, readJson, toResponse } from '$lib/server/http';

/** POST /api/daily/select { date, rank } — make another candidate of the day current. */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	if (!isIsoDate(b.date) || typeof b.rank !== 'number') return apiError(400, { error: 'bad_request' });
	try {
		const sql = db();
		const result = await select(sql, b.date, b.rank);
		return json({ result, deck: await loadDeck(sql, b.date, !!config().githubDispatchToken) });
	} catch (e) {
		return toResponse(e);
	}
};
