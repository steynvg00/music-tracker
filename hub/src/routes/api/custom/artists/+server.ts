import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { searchArtists } from '$lib/server/custom';
import { toResponse } from '$lib/server/http';

/** GET /api/custom/artists?q= — search-as-you-type over the artists in your history. */
export const GET: RequestHandler = async ({ url }) => {
	try {
		return json({ artists: await searchArtists(db(), (url.searchParams.get('q') ?? '').slice(0, 100)) });
	} catch (e) {
		return toResponse(e);
	}
};
