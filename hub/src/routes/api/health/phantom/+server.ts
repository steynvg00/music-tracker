import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { phantomPayload, PHANTOM_PAGE } from '$lib/server/phantom';
import { toResponse } from '$lib/server/http';

/** GET /api/health/phantom?limit=30 — phantom plays (Streamlit's population), newest first (R8). */
export const GET: RequestHandler = async ({ url }) => {
	try {
		const limit = Number(url.searchParams.get('limit') ?? PHANTOM_PAGE);
		return json(await phantomPayload(db(), limit), { headers: { 'Cache-Control': 'private, max-age=60' } });
	} catch (e) {
		return toResponse(e);
	}
};
