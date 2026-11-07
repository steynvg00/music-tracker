import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/http';
import { reorderPins } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

/** PUT /api/library/pins {targets:[…]} — the pinned list in this order (drag to reorder). */
export const PUT: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return organiserResponse(() => reorderPins(db(), body.targets));
};
