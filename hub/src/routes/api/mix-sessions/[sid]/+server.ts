import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { sessionSummary } from '$lib/server/mixes';
import { apiError, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** GET — session summary: every handoff with its outcome and gap, and the median gap. */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const s = await sessionSummary(db(), jobIdParam(params.sid));
		return s ? json(s) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};
