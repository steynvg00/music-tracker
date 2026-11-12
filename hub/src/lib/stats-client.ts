/** Page loaders for Stats, detail pages and Search (R3): one API call, status kept for error states.
 * v0.92: through the stale-while-revalidate cache (lib/swr.svelte.ts): instant on a revisit. */
import { swrLoad, type Loaded } from './swr.svelte';
export type { Loaded };

export function loadApi<T>(f: typeof fetch, path: string): Promise<Loaded<T>> {
	return swrLoad<T>(f, path);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2024-03' → 'Mar 24'; '2024-03-05' → '5 Mar'. */
export function shortPeriod(x: string): string {
	const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(x);
	if (!m) return x;
	const mon = MONTHS[Number(m[2]) - 1] ?? m[2];
	return m[3] ? `${Number(m[3])} ${mon}` : `${mon} ${m[1]!.slice(2)}`;
}
