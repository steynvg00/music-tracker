import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError, readJson } from '$lib/server/http';
import { catalog } from '$lib/server/services';
import { appearsTracks, APPEARS_BATCH } from '$lib/server/catalog/service';
import { catalogResponse } from '$lib/server/catalog/http';
import { SPOTIFY_ID } from '$lib/shared/catalog';

/** POST /api/catalog/artist/{id}/appears {albums:[id…]} — this artist's own tracks on "Appears on" releases. */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = params.id ?? '';
	if (!SPOTIFY_ID.test(id)) return apiError(404, { error: 'not_found' });
	const body = await readJson(request);
	const albums = Array.isArray(body.albums) ? body.albums.filter((a): a is string => typeof a === 'string' && SPOTIFY_ID.test(a)) : [];
	if (!albums.length || albums.length > APPEARS_BATCH) return apiError(400, { error: 'bad_request', message: `1–${APPEARS_BATCH} album ids` });
	const sql = db();
	const client = await catalog();
	return catalogResponse(async () => ({ tracks: await appearsTracks(sql, client, id, albums) }));
};
