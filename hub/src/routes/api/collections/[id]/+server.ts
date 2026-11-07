import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteCollection, getCollection } from '$lib/server/elsewhere';
import { apiError, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** GET /api/collections/{id} — one collection with its items (in order). */
export const GET: RequestHandler = async ({ params }) => {
	const id = jobIdParam(params.id);
	try {
		const c = await getCollection(db(), id);
		return c ? json(c) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};

/** DELETE /api/collections/{id} — remove it from Rotor (nothing on YouTube/SoundCloud changes). */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = jobIdParam(params.id);
	try {
		return (await deleteCollection(db(), id)) ? json({ deleted: true }) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};
