import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { requestBuild } from '$lib/server/wrapped';
import { localDate } from '$lib/server/time';
import { toResponse } from '$lib/server/http';

/** POST /api/wrapped/{year}/freeze — freeze a past year: wrapped_build job, or inline without jobs. */
export const POST: RequestHandler = async ({ params }) => {
	try {
		return json(await requestBuild(db(), config(), Number(params.year), localDate()));
	} catch (e) {
		return toResponse(e);
	}
};
