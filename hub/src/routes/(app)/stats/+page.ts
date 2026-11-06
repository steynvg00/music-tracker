import { loadApi } from '$lib/stats-client';
import type { Overview } from '$lib/server/stats/core';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({ r: await loadApi<Overview>(fetch, '/api/stats/overview') });
