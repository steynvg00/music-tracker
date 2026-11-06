import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { requestRebuild } from '$lib/server/library';
import { enqueueAndDispatch, jobsAvailable } from '$lib/server/jobs';
import { toResponse } from '$lib/server/http';
import { playlistIdParam } from '$lib/server/playlist-id';

/**
 * POST /api/playlists/{id}/rebuild — snapshot rebuild (Auto 📸 only). Records the force-refresh
 * request (same as Streamlit) and, when jobs are available, rebuilds now; otherwise the next
 * daily hub-jobs run does it.
 */
export const POST: RequestHandler = async ({ params }) => {
	const id = playlistIdParam(params.id);
	try {
		const sql = db();
		const cfg = config();
		await requestRebuild(sql, id);
		if (!jobsAvailable(cfg)) return json({ requested: true, job: null });
		const { job } = await enqueueAndDispatch(sql, cfg, 'refresh_managed', { playlist_id: id }, `refresh:${id}`);
		return json({ requested: true, job });
	} catch (e) {
		return toResponse(e);
	}
};
