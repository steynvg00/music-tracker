import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { requireManaged } from '$lib/server/library';
import { enqueueAndDispatch } from '$lib/server/jobs';
import { toResponse } from '$lib/server/http';
import { playlistIdParam } from '$lib/server/playlist-id';
import { BadInput } from '$lib/shared/custom';
import { isRadarPlaylistName } from '$lib/shared/radar';

/** POST /api/playlists/{id}/refresh — "Refresh this playlist now": a refresh_managed job (Auto 🔄 only). */
export const POST: RequestHandler = async ({ params }) => {
	const id = playlistIdParam(params.id);
	try {
		const sql = db();
		const row = await requireManaged(sql, id, 'auto_updating');
		// R7: the radar playlist has no definition in lib/playlists.py; only the Release radar rewrites it.
		if (isRadarPlaylistName(row.name)) throw new BadInput('This playlist is rewritten by the Release radar (Update playlist)');
		return json(await enqueueAndDispatch(sql, config(), 'refresh_managed', { playlist_id: id }, `refresh:${id}`));
	} catch (e) {
		return toResponse(e);
	}
};
