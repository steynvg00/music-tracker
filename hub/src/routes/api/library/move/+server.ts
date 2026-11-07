import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/http';
import { moveItems } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

/** POST /api/library/move {keys:[…], folderId: id | null} — into a folder or back to the root. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return organiserResponse(() => moveItems(db(), body.keys, body.folderId));
};
