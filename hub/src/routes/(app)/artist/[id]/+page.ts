import { browser } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { loadApi } from '$lib/stats-client';
import type { ArtistDetail } from '$lib/server/stats/detail';
import { flagOn } from '$lib/stores/flags.svelte';
import type { PageLoad } from './$types';

/**
 * v0.90: every artist link in Rotor points here. With "Artist pages (beta)" on for this device it
 * opens the beta page instead; ?stats=1 (the beta page's "Full stats & badges") keeps this page.
 * A server-rendered first load can't see the device flag: +page.svelte redirects after hydration.
 */
export const load: PageLoad = async ({ fetch, params, url }) => {
	if (browser && !url.searchParams.has('stats') && flagOn('artistPages')) redirect(307, `/catalog/artist/${params.id}`);
	return { r: await loadApi<ArtistDetail>(fetch, `/api/artist/${params.id}`) };
};
