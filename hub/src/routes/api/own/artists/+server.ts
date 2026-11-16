import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { artistOptions, createRotorArtist } from '$lib/server/own';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';

/** GET /api/own/artists?q= — artists to link: yours from Spotify + Rotor artists. */
export const GET: RequestHandler = ({ url }) => run(async () => ({ artists: await artistOptions(db(), url.searchParams.get('q') ?? '') }));
/** POST /api/own/artists {name} — create a Rotor artist explicitly (409 if it's already in your data). */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	return run(() => createRotorArtist(db(), body), 201);
};
