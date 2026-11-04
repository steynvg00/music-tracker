import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { generatedTrackRows, playlistTrackRows } from '$lib/server/daily';
import { isIsoDate } from '$lib/server/time';
import { apiError, toResponse } from '$lib/server/http';

/** GET /api/daily/tracks?date=&rank= — track list for the daily-pick detail. */
export const GET: RequestHandler = async ({ url }) => {
	const date = url.searchParams.get('date');
	const rank = Number(url.searchParams.get('rank'));
	if (!isIsoDate(date) || !Number.isInteger(rank)) return apiError(400, { error: 'bad_request' });
	try {
		const sql = db();
		const [c] = await sql<{ kind: string; track_uris: string[] | null; playlist_id: string | null; is_owned: boolean | null; is_collab: boolean | null }[]>`
			SELECT c.kind, c.track_uris, c.playlist_id, p.is_owned, p.is_collab
			FROM daily_pick_candidates c LEFT JOIN spotify_playlists p ON p.playlist_id = c.playlist_id
			WHERE c.pick_date = ${date} AND c.rank = ${rank}`;
		if (!c) return apiError(404, { error: 'not_found' });
		if (c.kind === 'generated') return json({ readable: true, tracks: await generatedTrackRows(sql, c.track_uris ?? []) });
		const readable = !!(c.is_owned || c.is_collab);
		return json({ readable, tracks: readable && c.playlist_id ? await playlistTrackRows(sql, c.playlist_id) : [] });
	} catch (e) {
		return toResponse(e);
	}
};
