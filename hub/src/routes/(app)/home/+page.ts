import type { HomePayload } from '$lib/shared/daily-types';
import type { PageLoad } from './$types';

/** One /api/home payload. The service worker may answer from cache first (X-Rotor-Stale). */
export const load: PageLoad = async ({ fetch }) => {
	const res = await fetch('/api/home');
	if (!res.ok) return { home: null as HomePayload | null, stale: false, error: res.status };
	return { home: (await res.json()) as HomePayload, stale: res.headers.get('x-rotor-stale') === '1', error: null };
};
