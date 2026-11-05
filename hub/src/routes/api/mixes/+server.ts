import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createMix, listMixes } from '$lib/server/mixes';
import { readJson, toResponse } from '$lib/server/http';

/** GET /api/mixes — your mixes (experimental). POST { name } — a new, empty mix. */
export const GET: RequestHandler = async () => {
	try {
		return json({ mixes: await listMixes(db()) });
	} catch (e) {
		return toResponse(e);
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		return json({ id: await createMix(db(), (await readJson(request)).name) }, { status: 201 });
	} catch (e) {
		return toResponse(e);
	}
};
