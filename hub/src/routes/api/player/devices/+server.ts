import { json, type RequestHandler } from '@sveltejs/kit';
import { spotify } from '$lib/server/services';
import { toResponse } from '$lib/server/http';
import { normalizeDevice } from '$lib/server/spotify/player';

/** GET /api/player/devices */
export const GET: RequestHandler = async () => {
	try {
		const { data } = await spotify().get<{ devices: Parameters<typeof normalizeDevice>[0][] }>('/me/player/devices');
		return json({ devices: (data?.devices ?? []).map(normalizeDevice) });
	} catch (e) {
		return toResponse(e);
	}
};
