import { loadApi } from '$lib/stats-client';
import type { WrappedYear } from '$lib/shared/wrapped';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({
	r: await loadApi<{ today: string; jobsAvailable: boolean; years: WrappedYear[] }>(fetch, '/api/wrapped')
});
