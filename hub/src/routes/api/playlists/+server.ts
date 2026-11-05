import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { libraryRows, ruleCategories } from '$lib/server/library';
import { mirrorAgeMs } from '$lib/server/spotify/mirror';
import { toResponse } from '$lib/server/http';

/** GET /api/playlists — the Library (mirror) + rule category names for group headers. */
export const GET: RequestHandler = async () => {
	try {
		const sql = db();
		const [rows, categories, age] = await Promise.all([libraryRows(sql), ruleCategories(sql), mirrorAgeMs(sql)]);
		return json({
			rows,
			categories: categories.map((c) => ({ key: c.key, name: c.name })),
			mirrorAgeMin: Number.isFinite(age) ? Math.round(age / 60000) : null
		});
	} catch (e) {
		return toResponse(e);
	}
};
