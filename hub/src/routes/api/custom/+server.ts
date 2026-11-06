import { json, type RequestHandler } from '@sveltejs/kit';
import { createCustom, parseExcluded } from '$lib/server/custom';
import { customDeps } from '$lib/server/custom-deps';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { isLifetime, parseFilters, validateCustomName } from '$lib/shared/custom';

/**
 * POST /api/custom { name, filters, excluded?, lifetime: '7d'|'30d'|'keep' }
 * Creates "<name> · Custom 🎧" (guarded create + add), records filters_json for Edit.
 */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	try {
		if (!isLifetime(b.lifetime)) return apiError(400, { error: 'bad_request', message: 'lifetime must be 7d, 30d or keep' });
		const created = await createCustom(customDeps(), {
			name: validateCustomName(b.name),
			filters: parseFilters(b.filters),
			excluded: parseExcluded(b.excluded),
			lifetime: b.lifetime
		});
		return json(created, { status: 201 });
	} catch (e) {
		return toResponse(e);
	}
};
