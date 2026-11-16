import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createSet, listSets } from '$lib/server/sets';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { ownDeps } from '$lib/server/services';

/** GET /api/sets?q=&artist= — DJ / live sets. */
export const GET: RequestHandler = ({ url }) =>
	run(async () => ({ sets: await listSets(db(), { q: url.searchParams.get('q') ?? undefined, artistId: url.searchParams.get('artist') ?? undefined }) }));
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return run(() => createSet(ownDeps(), body), 201);
};
