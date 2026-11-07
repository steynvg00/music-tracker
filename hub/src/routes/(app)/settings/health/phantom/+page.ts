import { loadApi } from '$lib/stats-client';
import type { PhantomPayload } from '$lib/server/phantom';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const limit = Number(url.searchParams.get('limit') ?? 30) || 30;
	return { limit, r: await loadApi<PhantomPayload>(fetch, `/api/health/phantom?limit=${limit}`) };
};
