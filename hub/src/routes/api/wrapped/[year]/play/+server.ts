import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { spotify, writeGuard } from '$lib/server/services';
import { playTop100 } from '$lib/server/wrapped';
import { localDate } from '$lib/server/time';
import { readJson, toResponse } from '$lib/server/http';

/**
 * POST /api/wrapped/{year}/play { device_id? } — "Play your top 100": create or replace
 * "Wrapped <year> · Auto 🤖📸" through the write guard, then play it.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const b = await readJson(request);
	const deviceId = typeof b.device_id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(b.device_id) ? b.device_id : null;
	try {
		const r = await playTop100(
			{ sql: db(), api: spotify(), guard: writeGuard(), ownerId: config().ownerSpotifyId },
			{ year: Number(params.year), today: localDate(), deviceId }
		);
		return json(r);
	} catch (e) {
		return toResponse(e);
	}
};
