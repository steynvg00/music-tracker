import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { connectionStatus } from '$lib/server/spotify/token';
import { toResponse } from '$lib/server/http';

/** GET /api/connections — authorization dates and countdowns (no secrets). */
export const GET: RequestHandler = async () => {
	try {
		return json(await connectionStatus(db()));
	} catch (e) {
		return toResponse(e);
	}
};
