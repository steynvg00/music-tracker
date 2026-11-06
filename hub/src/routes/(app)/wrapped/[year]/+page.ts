import { loadApi } from '$lib/stats-client';
import type { WrappedResponse } from '$lib/shared/wrapped';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({
	year: Number(params.year),
	r: await loadApi<WrappedResponse>(fetch, `/api/wrapped/${encodeURIComponent(params.year)}`)
});
