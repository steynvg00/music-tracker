import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { endSession, sessionSummary } from '$lib/server/mixes';
import { readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** POST { finalState } — end the session; returns its summary. */
export const POST: RequestHandler = async ({ params, request }) => {
	const sid = jobIdParam(params.sid);
	try {
		await endSession(db(), sid, (await readJson(request)).finalState);
		return json(await sessionSummary(db(), sid));
	} catch (e) {
		return toResponse(e);
	}
};
