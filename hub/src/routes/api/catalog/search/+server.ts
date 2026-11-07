import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { catalog } from '$lib/server/services';
import { catalogSearch } from '$lib/server/catalog/service';
import { catalogResponse } from '$lib/server/catalog/http';
import { SEARCH_TYPES, type SearchType } from '$lib/shared/catalog';

/** GET /api/catalog/search?q=&type=artist,album,track&offset= — the Spotify catalog, 10 per type per page. */
export const GET: RequestHandler = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const types = (url.searchParams.get('type') ?? '').split(',').filter((t): t is SearchType => (SEARCH_TYPES as string[]).includes(t));
	const offset = Math.max(0, Math.min(990, Math.floor(Number(url.searchParams.get('offset') ?? 0)) || 0));
	const sql = db();
	const client = await catalog();
	return catalogResponse(() => catalogSearch(sql, client, q, types.length ? types : SEARCH_TYPES, offset));
};
