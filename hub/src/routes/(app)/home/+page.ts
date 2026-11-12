import type { HomePayload } from '$lib/shared/daily-types';
import { homeWrappedCard } from '$lib/shared/wrapped';
import type { PageLoad } from './$types';
import { swrLoad } from '$lib/swr.svelte';

/**
 * One /api/home payload. The service worker may answer from cache first (X-Rotor-Stale).
 * R8: the Wrapped card (1 Dec → 31 Jan, Amsterdam date) is decided here, not after hydration:
 * the server's answer is reused when the page hydrates, so server and browser agree and the
 * card is in the first paint instead of pushing the shelves down later.
 */
export const load: PageLoad = async ({ fetch }) => {
	const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
	const wrappedCard = homeWrappedCard(today);
	// v0.92: through the app's SWR cache: a revisit shows the last Home at once, then refreshes in place.
	const r = await swrLoad<HomePayload>(fetch, '/api/home');
	return { r, home: r.data, stale: false, error: r.data ? null : r.status || 0, wrappedCard };
};
