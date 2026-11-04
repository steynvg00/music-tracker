import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { spotify } from '$lib/server/services';
import { syncMirror } from '$lib/server/spotify/mirror';
import { readJson, toResponse } from '$lib/server/http';

/** POST /api/playlists/sync { force? } — refresh the mirror's metadata if older than 1 h. */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	try {
		return json(await syncMirror(db(), spotify(), config().ownerSpotifyId, b.force === true));
	} catch (e) {
		return toResponse(e);
	}
};
