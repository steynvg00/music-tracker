import { loadApi } from '$lib/stats-client';
import type { AlbumDetail } from '$lib/server/stats/detail';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<AlbumDetail>(fetch, `/api/album/${params.id}`) });
