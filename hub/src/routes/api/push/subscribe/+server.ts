import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { parseSubscription, saveSubscription } from '$lib/server/push';
import { readJson, toResponse } from '$lib/server/http';

/** POST /api/push/subscribe { endpoint, keys: { p256dh, auth }, device_label? } */
export const POST: RequestHandler = async ({ request }) => {
	try {
		await saveSubscription(db(), parseSubscription(await readJson(request)));
		return json({ ok: true });
	} catch (e) {
		return toResponse(e);
	}
};
