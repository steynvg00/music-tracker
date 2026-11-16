import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteOwnTrack, getOwnTrack, updateOwnTrack } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { ownDeps } from '$lib/server/services';

export const GET: RequestHandler = ({ params }) => run(() => getOwnTrack(db(), params.id ?? ''));
/** PUT /api/own/{id} — replace every field (same validation as create). */
export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	return run(() => updateOwnTrack(ownDeps(), params.id ?? '', body));
};
/** DELETE /api/own/{id} — the track, its credits, plays and its uploaded files (storage + DB). */
export const DELETE: RequestHandler = ({ params }) => run(() => deleteOwnTrack(ownDeps(), params.id ?? ''));
