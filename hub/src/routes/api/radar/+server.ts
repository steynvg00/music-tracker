import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { loadRadar } from '$lib/server/radar';
import { localDate } from '$lib/server/time';
import { toResponse } from '$lib/server/http';
import { isRollupsMissing, rollupsMissing } from '$lib/server/stats/http';
import { RADAR_MISSING } from '$lib/shared/radar';

/** GET /api/radar?artist=<key>&followed=1 — Coming up, Recently out, artist filter, source health (R7). */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const artist = (url.searchParams.get('artist') ?? '').slice(0, 200) || null;
		const body = await loadRadar(db(), localDate(), { artist, followedOnly: url.searchParams.get('followed') === '1' });
		return json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });
	} catch (e) {
		if (isRollupsMissing(e)) return rollupsMissing(RADAR_MISSING);
		return toResponse(e);
	}
};
