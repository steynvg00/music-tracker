import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { spotify, writeGuard } from '$lib/server/services';
import { playCandidate } from '$lib/server/daily';
import { isIsoDate } from '$lib/server/time';
import { apiError, readJson, toResponse } from '$lib/server/http';

/**
 * POST /api/daily/play { date, rank, device_id?, offset? }
 * Generated pick: rewrite 'Daily pick · Auto 🤖🔄' (write guard) then play it.
 * Existing playlist: play as-is, nothing written.
 */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	if (!isIsoDate(b.date) || typeof b.rank !== 'number') return apiError(400, { error: 'bad_request' });
	const deviceId = typeof b.device_id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(b.device_id) ? b.device_id : null;
	const offset = typeof b.offset === 'number' && Number.isInteger(b.offset) && b.offset >= 0 && b.offset < 500 ? b.offset : 0;
	try {
		const result = await playCandidate(
			{ sql: db(), api: spotify(), guard: writeGuard(), ownerId: config().ownerSpotifyId },
			{ date: b.date, rank: b.rank, deviceId, offset }
		);
		return json(result);
	} catch (e) {
		return toResponse(e);
	}
};
