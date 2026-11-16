import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { prefill } from '$lib/server/prefill';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { catalog } from '$lib/server/services';
import { catalogSearch } from '$lib/server/catalog/service';

/** POST /api/own/prefill {title, artist, youtubeUrl, soundcloudUrl} — suggestions to confirm field by field. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const sql = db();
	return run(async () => {
		const client = await catalog().catch(() => null);
		return prefill({ sql, spotifySearch: client ? (q) => catalogSearch(sql, client, q, ['track']) : null }, body);
	});
};
