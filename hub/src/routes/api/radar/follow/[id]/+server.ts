import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { follow, isFollowed, unfollow } from '$lib/server/radar';
import { readJson, toResponse } from '$lib/server/http';
import { isRollupsMissing, rollupsMissing } from '$lib/server/stats/http';
import { RADAR_MISSING } from '$lib/shared/radar';

/**
 * "Follow in Rotor" (R7): GET → { followed }, PUT { name } → follow, DELETE → unfollow.
 * Adds the artist to the Release radar only; nothing is followed on Spotify.
 */
async function run(fn: () => Promise<unknown>): Promise<Response> {
	try {
		return json(await fn());
	} catch (e) {
		if (isRollupsMissing(e)) return rollupsMissing(RADAR_MISSING);
		return toResponse(e);
	}
}

export const GET: RequestHandler = ({ params }) => run(async () => ({ followed: await isFollowed(db(), params.id!) }));

export const PUT: RequestHandler = async ({ params, request }) => {
	const b = await readJson(request);
	return run(async () => {
		await follow(db(), params.id!, typeof b.name === 'string' ? b.name : '');
		return { followed: true };
	});
};

export const DELETE: RequestHandler = ({ params }) =>
	run(async () => {
		await unfollow(db(), params.id!);
		return { followed: false };
	});
