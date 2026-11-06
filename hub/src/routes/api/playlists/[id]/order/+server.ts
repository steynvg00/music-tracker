import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { setOrderPref } from '$lib/server/library';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { playlistIdParam } from '$lib/server/playlist-id';
import { isOrderPref } from '$lib/shared/order-prefs';

/** POST /api/playlists/{id}/order { order_pref } — Auto 🔄 only (403 otherwise); applied at the next refresh. */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = playlistIdParam(params.id);
	const b = await readJson(request);
	if (!isOrderPref(b.order_pref)) return apiError(400, { error: 'bad_request', message: 'unknown order preference' });
	try {
		await setOrderPref(db(), id, b.order_pref);
		return json({ ok: true, orderPref: b.order_pref });
	} catch (e) {
		return toResponse(e);
	}
};
