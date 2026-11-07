import type { HomePayload } from '$lib/shared/daily-types';
import { homeWrappedCard } from '$lib/shared/wrapped';
import type { PageLoad } from './$types';

/**
 * One /api/home payload. The service worker may answer from cache first (X-Rotor-Stale).
 * R8: the Wrapped card (1 Dec → 31 Jan, Amsterdam date) is decided here, not after hydration:
 * the server's answer is reused when the page hydrates, so server and browser agree and the
 * card is in the first paint instead of pushing the shelves down later.
 */
export const load: PageLoad = async ({ fetch }) => {
	const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
	const wrappedCard = homeWrappedCard(today);
	const res = await fetch('/api/home');
	if (!res.ok) return { home: null as HomePayload | null, stale: false, error: res.status, wrappedCard };
	return { home: (await res.json()) as HomePayload, stale: res.headers.get('x-rotor-stale') === '1', error: null, wrappedCard };
};
