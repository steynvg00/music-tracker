import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createOwnTrack, listOwnTracks } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { ownDeps } from '$lib/server/services';

/** GET /api/own?q=&artist= — your own tracks (unreleased / IDs). Never Spotify data. */
export const GET: RequestHandler = ({ url }) =>
	run(async () => ({ tracks: await listOwnTracks(db(), { q: url.searchParams.get('q') ?? undefined, artistId: url.searchParams.get('artist') ?? undefined }) }));

/** POST /api/own — create (400 per-field errors, 409 possible duplicate unless confirmDuplicate). */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return run(() => createOwnTrack(ownDeps(), body), 201);
};
