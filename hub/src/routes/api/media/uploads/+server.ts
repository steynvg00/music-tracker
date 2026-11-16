import type { RequestHandler } from '@sveltejs/kit';
import { startUpload } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { requireMedia } from '$lib/server/services';

/** POST /api/media/uploads {purpose, name, size, type} — accept a file and sign its direct upload. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return run(() => startUpload(requireMedia(), body), 201);
};
