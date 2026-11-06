import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getJob } from '$lib/server/jobs';
import { apiError, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** GET /api/jobs/{id} — one job (the UI polls this while it's queued/running). */
export const GET: RequestHandler = async ({ params }) => {
	const id = jobIdParam(params.id);
	try {
		const job = await getJob(db(), id);
		return job ? json(job) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};
