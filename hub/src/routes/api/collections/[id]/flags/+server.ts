import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { flagItem } from '$lib/server/elsewhere';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

const FLAGS = new Set(['not_embeddable', 'preview_only', 'unavailable']);

/** POST /api/collections/{id}/flags { mediaItemId, flag } — what the player found out at play time. */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = jobIdParam(params.id);
	const b = await readJson(request);
	const item = jobIdParam(typeof b.mediaItemId === 'string' ? b.mediaItemId : undefined);
	if (typeof b.flag !== 'string' || !FLAGS.has(b.flag)) return apiError(400, { error: 'bad_request', message: 'unknown flag' });
	try {
		return (await flagItem(db(), id, item, b.flag as 'not_embeddable')) ? json({ ok: true }) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};
