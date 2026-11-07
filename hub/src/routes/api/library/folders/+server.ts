import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { readJson } from '$lib/server/http';
import { createFolder } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

/** POST /api/library/folders {name, parentId?} — a Rotor folder (nothing changes in Spotify). */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return organiserResponse(async () => ({ folder: await createFolder(db(), body) }), 201);
};
