import { loadApi } from '$lib/stats-client';
import type { DjSet } from '$lib/shared/sets';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<DjSet>(fetch, `/api/sets/${params.id}`) });
