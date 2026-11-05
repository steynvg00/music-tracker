import { json, type RequestHandler } from '@sveltejs/kit';
import { createCustomFromTracks } from '$lib/server/custom';
import { customDeps } from '$lib/server/custom-deps';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { isLifetime, validateCustomName } from '$lib/shared/custom';

/**
 * POST /api/custom/from-tracks { name, uris[], lifetime, source } — "Save as custom playlist"
 * from a Stats list (R3). Creates "<name> · Custom 🎧" through the write guard.
 */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	try {
		if (!isLifetime(b.lifetime)) return apiError(400, { error: 'bad_request', message: 'lifetime must be 7d, 30d or keep' });
		if (!Array.isArray(b.uris) || b.uris.length === 0 || b.uris.length > 500) {
			return apiError(400, { error: 'bad_request', message: 'uris must be a list of 1–500 track URIs' });
		}
		const created = await createCustomFromTracks(customDeps(), {
			name: validateCustomName(b.name),
			uris: b.uris.filter((u: unknown): u is string => typeof u === 'string'),
			lifetime: b.lifetime,
			source: typeof b.source === 'string' && b.source.trim() ? b.source.trim() : 'Rotor Stats'
		});
		return json(created, { status: 201 });
	} catch (e) {
		return toResponse(e);
	}
};
