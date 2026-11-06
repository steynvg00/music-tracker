import { loadApi } from '$lib/stats-client';
import type { SearchResults } from '$lib/server/stats/detail';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams.get('q') ?? '';
	return { q, r: q.trim().length >= 2 ? await loadApi<SearchResults>(fetch, `/api/search?q=${encodeURIComponent(q)}`) : null };
};
