import { loadApi } from '$lib/stats-client';
import type { DataHealth } from '$lib/shared/health';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => ({ r: await loadApi<DataHealth>(fetch, url.searchParams.get('fresh') === '1' ? '/api/health?fresh=1' : '/api/health') });
