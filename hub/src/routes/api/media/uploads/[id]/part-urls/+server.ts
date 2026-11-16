import type { RequestHandler } from '@sveltejs/kit';
import { reportPart, signParts } from '$lib/server/media';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { requireMedia } from '$lib/server/services';

/** POST {parts: [n…]} — fresh short-lived URLs for these parts. */
export const POST: RequestHandler = async ({ params, request }) => {
	const b = await readJson(request);
	return run(() => signParts(requireMedia(), params.id ?? '', b.parts));
};
/** PUT {n, etag} — the browser finished part n. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const b = await readJson(request);
	return run(() => reportPart(requireMedia(), params.id ?? '', b));
};
