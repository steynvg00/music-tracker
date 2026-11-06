import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { PlaylistDetail } from '$lib/shared/playlist-detail';

export const load: PageLoad = async ({ fetch, params }) => {
	if (!/^[A-Za-z0-9]{22}$/.test(params.id)) error(404, 'Not found');
	const res = await fetch(`/api/playlists/${params.id}`);
	if (res.status === 404) error(404, 'This playlist is not in your library');
	if (!res.ok) error(res.status, 'Could not load the playlist');
	return { detail: (await res.json()) as PlaylistDetail };
};
