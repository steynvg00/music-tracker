import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { recordPlay } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';

/** POST /api/own/{id}/plays {msPlayed} — a play in Rotor's own player (own_plays, source 'rotor'). */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = await readJson(request);
	return run(() => recordPlay(db(), params.id ?? '', body), 201);
};
