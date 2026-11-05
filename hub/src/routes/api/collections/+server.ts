import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { importSoundCloud, importYouTube, listCollections } from '$lib/server/elsewhere';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { parseLink, type Source } from '$lib/shared/elsewhere';

/** GET /api/collections?source=youtube|soundcloud — imported Elsewhere collections. */
export const GET: RequestHandler = async ({ url }) => {
	const s = url.searchParams.get('source');
	const source: Source | null = s === 'youtube' || s === 'soundcloud' ? s : null;
	try {
		const cfg = config();
		return json({ collections: await listCollections(db(), source), youtubeKey: !!cfg.youtubeApiKey });
	} catch (e) {
		return toResponse(e);
	}
};

/**
 * POST /api/collections { url } — import a YouTube playlist/video (Data API, server key) or a
 * SoundCloud set/track (oEmbed). Re-importing the same link refreshes it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const b = await readJson(request);
	const link = parseLink(typeof b.url === 'string' ? b.url : '');
	if ('error' in link) return apiError(400, { error: 'bad_request', message: link.error });
	try {
		const sql = db();
		const r = link.source === 'youtube' ? await importYouTube(sql, config().youtubeApiKey, link) : await importSoundCloud(sql, link);
		return json(r, { status: 201 });
	} catch (e) {
		return toResponse(e);
	}
};
