import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { notificationPrefs, setNotificationPref } from '$lib/server/notifications';
import { readJson, toResponse } from '$lib/server/http';

/** GET /api/notifications — every notification type and whether it's on (R9). */
export const GET: RequestHandler = async () => {
	try {
		return json(await notificationPrefs(db()), { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (e) {
		return toResponse(e);
	}
};

/** PUT /api/notifications {kind, enabled} — switch one type on or off. */
export const PUT: RequestHandler = async ({ request }) => {
	try {
		const b = await readJson(request);
		await setNotificationPref(db(), b.kind, b.enabled);
		return json(await notificationPrefs(db()));
	} catch (e) {
		return toResponse(e);
	}
};
