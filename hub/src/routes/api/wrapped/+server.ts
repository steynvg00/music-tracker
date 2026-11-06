import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { jobsAvailable } from '$lib/server/jobs';
import { listYears } from '$lib/server/wrapped';
import { localDate } from '$lib/server/time';
import { toResponse } from '$lib/server/http';
import { isRollupsMissing, rollupsMissing } from '$lib/server/stats/http';
import { WRAPPED_MISSING } from '$lib/shared/wrapped';

/** GET /api/wrapped — the year picker: 2017 → this year, each so_far / frozen / buildable (R6). */
export const GET: RequestHandler = async () => {
	try {
		const today = localDate();
		return json({ today, jobsAvailable: jobsAvailable(config()), years: await listYears(db(), today) });
	} catch (e) {
		if (isRollupsMissing(e)) return rollupsMissing(WRAPPED_MISSING);
		return toResponse(e);
	}
};
