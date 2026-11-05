import { error } from '@sveltejs/kit';

/** Route param guard: Spotify playlist ids are 22 base62 characters. */
export function playlistIdParam(id: string | undefined): string {
	if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) error(404, 'Not found');
	return id;
}

export function jobIdParam(id: string | undefined): string {
	if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) error(404, 'Not found');
	return id;
}
