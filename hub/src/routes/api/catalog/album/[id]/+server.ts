import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError } from '$lib/server/http';
import { catalog } from '$lib/server/services';
import { catalogAlbum } from '$lib/server/catalog/service';
import { catalogResponse } from '$lib/server/catalog/http';
import { SPOTIFY_ID } from '$lib/shared/catalog';

/** GET /api/catalog/album/{id} — full album from Spotify (live, never stored) + your state per track. */
export const GET: RequestHandler = async ({ params }) => {
	const id = params.id ?? '';
	if (!SPOTIFY_ID.test(id)) return apiError(404, { error: 'not_found' });
	const sql = db();
	const client = await catalog();
	return catalogResponse(() => catalogAlbum(sql, client, id));
};
