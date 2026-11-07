import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { dataHealth } from '$lib/server/health';
import { toResponse } from '$lib/server/http';

/** GET /api/health[?fresh=1] — Settings › Data health (R8). GitHub is read with the dispatch token (cached 5 min; fresh=1 skips the cache). */
export const GET: RequestHandler = async ({ url }) => {
	try {
		return json(await dataHealth(db(), config(), fetch, new Date(), { fresh: url.searchParams.get('fresh') === '1' }), { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (e) {
		return toResponse(e);
	}
};
