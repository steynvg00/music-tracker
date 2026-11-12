import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { PlaylistDetail } from '$lib/shared/playlist-detail';
import { swrLoad } from '$lib/swr.svelte';

export const load: PageLoad = async ({ fetch, params }) => {
	if (!/^[A-Za-z0-9]{22}$/.test(params.id)) error(404, 'Not found');
	// v0.92: SWR cache: instant on a revisit, refreshed in place.
	const r = await swrLoad<PlaylistDetail>(fetch, `/api/playlists/${params.id}`);
	if (r.status === 404) error(404, 'This playlist is not in your library');
	if (!r.data) error(r.status || 503, 'Could not load the playlist');
	return { r, detail: r.data };
};
