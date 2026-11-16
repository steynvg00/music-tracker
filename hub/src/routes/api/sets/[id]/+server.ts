import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteSet, getSet, updateSet } from '$lib/server/sets';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { ownDeps } from '$lib/server/services';

export const GET: RequestHandler = ({ params }) => run(() => getSet(db(), params.id ?? ''));
export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	return run(() => updateSet(ownDeps(), params.id ?? '', body));
};
/** DELETE — the set, its tracklist and its uploaded audio/cover (storage + DB). */
export const DELETE: RequestHandler = ({ params }) => run(() => deleteSet(ownDeps(), params.id ?? ''));
