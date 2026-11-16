import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { findDuplicates } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';

/** POST /api/own/duplicates {title, version, artists: [names], excludeId} — live duplicate check for the form. */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	const title = typeof b.title === 'string' ? b.title.slice(0, 200) : '';
	const artists = Array.isArray(b.artists) ? b.artists.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
	return run(async () => ({
		matches: title.trim() ? await findDuplicates(db(), { title, version: typeof b.version === 'string' ? b.version : null, artists }, typeof b.excludeId === 'string' ? b.excludeId : null) : []
	}));
};
