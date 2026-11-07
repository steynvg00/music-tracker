import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { apiError, readJson } from '$lib/server/http';
import { deleteFolder, updateFolder } from '$lib/server/organiser';
import { organiserResponse } from '$lib/server/organiser-http';

const idOf = (p: string | undefined) => (/^\d{1,12}$/.test(p ?? '') ? Number(p) : null);

/** PATCH /api/library/folders/{id} {name?, parentId?} — rename / nest (one level) / move to the root. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = idOf(params.id);
	if (id === null) return apiError(404, { error: 'not_found' });
	const body = await readJson(request);
	return organiserResponse(async () => ({ folder: await updateFolder(db(), id, body) }));
};

/** DELETE /api/library/folders/{id} — its playlists and subfolders go back to the root; no playlist is deleted. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = idOf(params.id);
	if (id === null) return apiError(404, { error: 'not_found' });
	return organiserResponse(() => deleteFolder(db(), id));
};
