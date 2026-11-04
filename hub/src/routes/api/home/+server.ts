import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { homePayload } from '$lib/server/home';
import { localDate } from '$lib/server/time';
import { toResponse } from '$lib/server/http';

/** GET /api/home — one payload for Home. The service worker keeps the last copy (stale-while-revalidate). */
export const GET: RequestHandler = async () => {
	try {
		const cfg = config();
		const body = await homePayload(db(), {
			today: localDate(),
			ownerId: cfg.ownerSpotifyId,
			reseedAvailable: !!cfg.githubDispatchToken
		});
		return json(body, { headers: { 'Cache-Control': 'private, no-cache' } });
	} catch (e) {
		return toResponse(e);
	}
};
