import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteSubscription } from '$lib/server/push';
import { apiError, readJson, toResponse } from '$lib/server/http';

/** POST /api/push/unsubscribe { endpoint } */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	if (typeof b.endpoint !== 'string' || !b.endpoint) return apiError(400, { error: 'bad_request' });
	try {
		await deleteSubscription(db(), b.endpoint);
		return json({ ok: true });
	} catch (e) {
		return toResponse(e);
	}
};
