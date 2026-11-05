import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { countMatches, preview } from '$lib/server/custom';
import { readJson, toResponse } from '$lib/server/http';
import { parseFilters } from '$lib/shared/custom';

/** POST /api/custom/preview { filters } → { count, tracks } (tracks respect Max tracks). Read-only. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const f = parseFilters((await readJson(request)).filters);
		const sql = db();
		const [count, tracks] = await Promise.all([countMatches(sql, f), preview(sql, f)]);
		return json({ count, tracks });
	} catch (e) {
		return toResponse(e);
	}
};
