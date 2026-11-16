import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createList, listLists } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';

/** Rotor-only lists of own tracks (never Spotify playlists). */
export const GET: RequestHandler = () => run(async () => ({ lists: await listLists(db()) }));
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return run(() => createList(db(), body), 201);
};
