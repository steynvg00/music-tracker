import { json, type RequestHandler } from '@sveltejs/kit';
import { tokenProvider } from '$lib/server/services';
import { toResponse } from '$lib/server/http';

/**
 * GET /api/spotify/token — a short-lived access token for the Web Playback SDK
 * ("This laptop"). The SDK requires a client-side token; the refresh token never
 * leaves the server.
 */
export const GET: RequestHandler = async () => {
	try {
		const accessToken = await tokenProvider().getAccessToken('hub');
		return json({ accessToken }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (e) {
		return toResponse(e);
	}
};
