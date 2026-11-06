import { loadApi } from '$lib/stats-client';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => ({ r: await loadApi<unknown>(fetch, `/api/stats/year${url.search}`) });
