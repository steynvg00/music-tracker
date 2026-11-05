import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteCustom, extendCustom, getCustom, keepCustom, parseExcluded, requireCustom, updateCustom } from '$lib/server/custom';
import { customDeps } from '$lib/server/custom-deps';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { playlistIdParam } from '$lib/server/playlist-id';
import { parseFilters } from '$lib/shared/custom';

/** GET /api/custom/{id} — the stored filters for Edit. 403 for anything that isn't Custom 🎧. */
export const GET: RequestHandler = async ({ params }) => {
	const id = playlistIdParam(params.id);
	try {
		await requireCustom(db(), id);
		return json(await getCustom(db(), id));
	} catch (e) {
		return toResponse(e);
	}
};

/**
 * POST /api/custom/{id} { action }
 *   update { filters, excluded } → replace items (guarded, Custom 🎧 only)
 *   extend → expires_at + 7 days · keep → no expiry · delete → guarded unfollow + row removed
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const id = playlistIdParam(params.id);
	const b = await readJson(request);
	try {
		switch (b.action) {
			case 'update':
				return json(await updateCustom(customDeps(), id, { filters: parseFilters(b.filters), excluded: parseExcluded(b.excluded) }));
			case 'extend':
				return json({ expiresAt: await extendCustom(db(), id) });
			case 'keep':
				await keepCustom(db(), id);
				return json({ expiresAt: null });
			case 'delete':
				await deleteCustom(customDeps(), id);
				return json({ deleted: true });
			default:
				return apiError(400, { error: 'bad_request', message: 'action must be update, extend, keep or delete' });
		}
	} catch (e) {
		return toResponse(e);
	}
};
