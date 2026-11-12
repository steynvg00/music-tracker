import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { scheduleRelay } from '$lib/server/mixes';
import { readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** POST { inMs, position, label } — iPhone relay: push "tap to continue" when this Spotify part ends. */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		return json(await scheduleRelay(db(), config(), jobIdParam(params.sid), await readJson(request)));
	} catch (e) {
		return toResponse(e);
	}
};
