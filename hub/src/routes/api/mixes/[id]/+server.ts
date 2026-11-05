import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteMix, getMix, saveMixItems } from '$lib/server/mixes';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** GET a mix with its items; PUT { name?, items: [{ source, spotifyUri | mediaItemId }] }; DELETE. */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const m = await getMix(db(), jobIdParam(params.id));
		return m ? json(m) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = jobIdParam(params.id);
	try {
		const b = await readJson(request);
		await saveMixItems(db(), id, b.items, b.name);
		return json(await getMix(db(), id));
	} catch (e) {
		return toResponse(e);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return (await deleteMix(db(), jobIdParam(params.id))) ? json({ deleted: true }) : apiError(404, { error: 'not_found' });
	} catch (e) {
		return toResponse(e);
	}
};
