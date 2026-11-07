import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/http';
import { reorderLevel } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

/** PUT /api/library/order {folderId: id | null, targets:[…]} — the custom order of one level. */
export const PUT: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return organiserResponse(() => reorderLevel(db(), body.folderId, body.targets));
};
