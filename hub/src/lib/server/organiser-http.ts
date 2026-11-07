import { json } from '@sveltejs/kit';
import { apiError, toResponse } from '$lib/server/http';
import { isRollupsMissing } from '$lib/server/stats/http';

/** Organiser answers: personal, never cached; 503 until migration 0034 is applied. */
export async function organiserResponse(compute: () => Promise<unknown>, status = 200): Promise<Response> {
	try {
		return json(await compute(), { status, headers: { 'Cache-Control': 'no-store' } });
	} catch (e) {
		if (isRollupsMissing(e)) return apiError(503, { error: 'organiser_missing', message: 'Pins and folders need migration 0034_library_organiser.sql' });
		return toResponse(e);
	}
}
