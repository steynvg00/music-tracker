import { swrLoad } from '$lib/swr.svelte';
import type { LibraryRow, Organiser } from '$lib/shared/library';
import type { PageLoad } from './$types';

/**
 * v0.92: the Library list is in the server-rendered page (it used to arrive only after hydration:
 * 4 s on a cold iPhone start), and instant on a revisit (SWR cache). The store takes over after mount.
 */
export const load: PageLoad = async ({ fetch }) => {
	const [lib, org] = await Promise.all([
		swrLoad<{ rows: LibraryRow[]; categories: { key: string; name: string }[]; mirrorAgeMin: number | null }>(fetch, '/api/playlists'),
		swrLoad<Organiser>(fetch, '/api/library')
	]);
	return { lib, org };
};
