import { loadApi } from '$lib/stats-client';
import type { TrackDetail } from '$lib/server/stats/detail';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<TrackDetail>(fetch, `/api/track/${encodeURIComponent(params.uri)}`) });
