import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { jobsAvailable, recentJobs } from '$lib/server/jobs';
import { toResponse } from '$lib/server/http';

/** GET /api/jobs — the 10 most recent jobs (Settings). */
export const GET: RequestHandler = async () => {
	try {
		return json({ jobs: await recentJobs(db()), available: jobsAvailable(config()) });
	} catch (e) {
		return toResponse(e);
	}
};
