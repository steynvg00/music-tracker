import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { spotify } from '$lib/server/services';
import { apiError, toResponse } from '$lib/server/http';
import { mirrorRow, nextRefresh, playlistSettings, playlistTracks, ruleCategory } from '$lib/server/library';
import { getCustom } from '$lib/server/custom';
import { jobsAvailable, latestPlaylistJob } from '$lib/server/jobs';
import { playlistIdParam } from '$lib/server/playlist-id';

/** GET /api/playlists/{id} — playlist detail: About this playlist, settings, custom state, tracks, last job. */
export const GET: RequestHandler = async ({ params }) => {
	const id = playlistIdParam(params.id);
	try {
		const sql = db();
		const row = await mirrorRow(sql, id);
		if (!row || row.removed_at) return apiError(404, { error: 'not_found', message: 'Not in your library' });
		const [category, settings, custom, tracks, job] = await Promise.all([
			ruleCategory(sql, row.rule_category),
			playlistSettings(sql, id),
			row.managed_kind === 'custom' ? getCustom(sql, id) : Promise.resolve(null),
			playlistTracks(sql, spotify(), row),
			row.managed_kind ? latestPlaylistJob(sql, id) : Promise.resolve(null)
		]);
		return json({
			playlist: {
				id: row.playlist_id,
				uri: `spotify:playlist:${row.playlist_id}`,
				name: row.name,
				imageUrl: row.image_url,
				kind: row.managed_kind,
				isOwned: row.is_owned,
				isCollab: row.is_collab,
				ownerName: row.owner_name,
				trackCount: row.track_count
			},
			category,
			nextRefresh: nextRefresh(category),
			settings,
			custom,
			tracks,
			job,
			jobsAvailable: jobsAvailable(config())
		});
	} catch (e) {
		return toResponse(e);
	}
};
