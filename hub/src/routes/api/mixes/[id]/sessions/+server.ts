import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { startSession } from '$lib/server/mixes';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { jobIdParam } from '$lib/server/playlist-id';

/** POST { mode: 'laptop'|'relay', deviceLabel?, spotifyDeviceId? } — start a session (telemetry). */
export const POST: RequestHandler = async ({ params, request }) => {
	const b = await readJson(request);
	if (b.mode !== 'laptop' && b.mode !== 'relay') return apiError(400, { error: 'bad_request', message: 'mode must be laptop or relay' });
	try {
		const id = await startSession(db(), jobIdParam(params.id), b.mode, typeof b.deviceLabel === 'string' ? b.deviceLabel.slice(0, 80) : null, typeof b.spotifyDeviceId === 'string' ? b.spotifyDeviceId.slice(0, 100) : null);
		return json({ id }, { status: 201 });
	} catch (e) {
		return toResponse(e);
	}
};
