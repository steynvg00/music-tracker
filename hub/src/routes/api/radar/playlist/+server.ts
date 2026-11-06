import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { spotify, writeGuard } from '$lib/server/services';
import { updatePlaylist } from '$lib/server/radar';
import { localDate } from '$lib/server/time';
import { toResponse } from '$lib/server/http';

/**
 * POST /api/radar/playlist — rewrite "New from your artists · Auto 🤖🔄" (write guard,
 * requireKind auto_updating) with the Spotify releases of the last 14 days. Nothing else is written.
 */
export const POST: RequestHandler = async () => {
	try {
		return json(await updatePlaylist({ sql: db(), api: spotify(), guard: writeGuard(), ownerId: config().ownerSpotifyId }, localDate()));
	} catch (e) {
		return toResponse(e);
	}
};
