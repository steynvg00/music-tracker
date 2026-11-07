import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError } from '$lib/server/http';
import { catalog } from '$lib/server/services';
import { artistPage } from '$lib/server/catalog/service';
import { catalogResponse } from '$lib/server/catalog/http';
import { SPOTIFY_ID } from '$lib/shared/catalog';

/** GET /api/catalog/artist/{id} — Artist pages (beta): header (your numbers) + full discography (cached 7 days). */
export const GET: RequestHandler = async ({ params }) => {
	const id = params.id ?? '';
	if (!SPOTIFY_ID.test(id)) return apiError(404, { error: 'not_found' });
	const sql = db();
	const client = await catalog();
	return catalogResponse(() => artistPage(sql, client, id));
};
