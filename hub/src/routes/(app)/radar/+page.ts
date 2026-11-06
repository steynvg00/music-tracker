import { loadApi } from '$lib/stats-client';
import type { RadarPayload } from '$lib/shared/radar';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const q = new URLSearchParams();
	const artist = url.searchParams.get('artist');
	if (artist) q.set('artist', artist);
	if (url.searchParams.get('followed') === '1') q.set('followed', '1');
	return {
		view: url.searchParams.get('view') === 'recent' ? ('recent' as const) : ('upcoming' as const),
		artist,
		followedOnly: url.searchParams.get('followed') === '1',
		r: await loadApi<RadarPayload>(fetch, `/api/radar${q.size ? `?${q}` : ''}`)
	};
};
