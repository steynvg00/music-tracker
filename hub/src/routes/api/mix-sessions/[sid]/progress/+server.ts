import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { setProgress } from '$lib/server/mixes';
import { readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** POST { position } — where the conductor is (the relay job skips its push once you've moved on). */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		await setProgress(db(), jobIdParam(params.sid), (await readJson(request)).position);
		return json({ ok: true });
	} catch (e) {
		return toResponse(e);
	}
};
