import { loadApi } from '$lib/stats-client';
import type { Mix } from '$lib/server/mixes';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<Mix>(fetch, `/api/mixes/${params.id}`) });
