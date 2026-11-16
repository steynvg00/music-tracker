/** v0.94 HTTP glue for own tracks, sets and uploads: JSON, no-store, errors via toResponse(). */
import { json } from '@sveltejs/kit';
import { apiError, toResponse } from '$lib/server/http';

export async function run(fn: () => Promise<unknown>, status = 200): Promise<Response> {
	try {
		const body = await fn();
		if (body === null || body === undefined) return apiError(404, { error: 'not_found' });
		return json(body, { status, headers: { 'Cache-Control': 'no-store' } });
	} catch (e) {
		return toResponse(e);
	}
}
