import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { logEvent } from '$lib/server/mixes';
import { readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** POST { from, to, outcome, gapMs?, position?, detail? } — one handoff_events row. */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		await logEvent(db(), jobIdParam(params.sid), await readJson(request));
		return json({ ok: true });
	} catch (e) {
		return toResponse(e);
	}
};
