import { loadApi } from '$lib/stats-client';
import type { CollectionDetail } from '$lib/shared/elsewhere';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({ r: await loadApi<CollectionDetail>(fetch, `/api/collections/${params.id}`) });
