import { loadApi } from '$lib/stats-client';
import type { ArtistDetail } from '$lib/server/stats/detail';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<ArtistDetail>(fetch, `/api/artist/${params.id}`) });
