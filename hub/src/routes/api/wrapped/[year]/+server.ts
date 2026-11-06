import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { loadWrapped } from '$lib/server/wrapped';
import { localDate } from '$lib/server/time';
import { statsResponse } from '$lib/server/stats/http';
import { WRAPPED_MISSING } from '$lib/shared/wrapped';

/**
 * GET /api/wrapped/{year} — this year: live "so far" payload; past years: the frozen snapshot,
 * 404 until it's built. ETag on the last rollup refresh (+ year + today), 30 s private cache.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const today = localDate();
	const year = Number(params.year);
	const sql = db();
	return statsResponse(sql, request, `wrapped|${year}|${today}`, () => loadWrapped(sql, year, today), WRAPPED_MISSING);
};
