import type { RequestHandler } from '@sveltejs/kit';
import { playbackUrl } from '$lib/server/media';
import { requireMedia } from '$lib/server/services';
import { toResponse } from '$lib/server/http';

/** GET /api/media/{id}/art — redirect to a short-lived signed URL of an uploaded cover (not "cover/": .gitignore) (for <img>). */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const { url } = await playbackUrl(requireMedia(), params.id ?? '');
		return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, max-age=60' } });
	} catch (e) {
		return toResponse(e);
	}
};
