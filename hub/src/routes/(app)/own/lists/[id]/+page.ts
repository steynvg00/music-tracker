import { loadApi } from '$lib/stats-client';
import type { OwnTrack, RotorList } from '$lib/shared/own';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<RotorList & { tracks: OwnTrack[] }>(fetch, `/api/own/lists/${params.id}`) });
