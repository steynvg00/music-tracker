import { json } from '@sveltejs/kit';
import { apiError, toResponse } from '$lib/server/http';
import { isRollupsMissing } from '$lib/server/stats/http';
import { NotOpened } from './service';

/** Catalog answers are personal (your state per track) and live: never cached by the browser or SW. */
export async function catalogResponse(compute: () => Promise<unknown>): Promise<Response> {
	try {
		return json(await compute(), { headers: { 'Cache-Control': 'no-store' } });
	} catch (e) {
		if (e instanceof NotOpened) return apiError(409, { error: 'not_opened', message: e.message });
		if (isRollupsMissing(e)) return apiError(503, { error: 'catalog_cache_missing', message: 'Artist pages need migrations 0023 and 0031' });
		return toResponse(e);
	}
}
