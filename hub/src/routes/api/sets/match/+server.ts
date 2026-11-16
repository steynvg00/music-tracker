import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { matchLines } from '$lib/server/sets';
import { run } from '$lib/server/own-http';
import { readJson } from '$lib/server/http';
import { parseTracklist } from '$lib/shared/sets';

/** POST /api/sets/match {text} — parse a pasted tracklist and suggest links (you confirm them). */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	const lines = parseTracklist(typeof b.text === 'string' ? b.text.slice(0, 50_000) : '');
	return run(async () => ({ lines, matches: await matchLines(db(), lines) }));
};
