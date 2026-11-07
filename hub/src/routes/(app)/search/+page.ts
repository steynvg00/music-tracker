import { loadApi } from '$lib/stats-client';
import type { SearchResults } from '$lib/server/stats/detail';
import type { PageLoad } from './$types';

/** ?src=spotify (v0.90 beta) = the Spotify catalog tab; it fetches its own results. */
export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams.get('q') ?? '';
	const src = url.searchParams.get('src') === 'spotify' ? 'spotify' : 'mine';
	return { q, src, r: src === 'mine' && q.trim().length >= 2 ? await loadApi<SearchResults>(fetch, `/api/search?q=${encodeURIComponent(q)}`) : null };
};
