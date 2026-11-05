import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { retry } from '$lib/server/jobs';
import { toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** POST /api/jobs/{id}/retry — failed → queued + dispatch again (max 3 attempts). */
export const POST: RequestHandler = async ({ params }) => {
	const id = jobIdParam(params.id);
	try {
		return json(await retry(db(), config(), id));
	} catch (e) {
		return toResponse(e);
	}
};
