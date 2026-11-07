import { loadApi } from '$lib/stats-client';
import type { DigestPayload } from '$lib/shared/digest';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const week = url.searchParams.get('week');
	return { r: await loadApi<DigestPayload>(fetch, `/api/digest${week ? `?week=${encodeURIComponent(week)}` : ''}`) };
};
