import { loadApi } from '$lib/stats-client';
import type { OwnTrack } from '$lib/shared/own';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<OwnTrack>(fetch, `/api/own/${params.id}`) });
