import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { spotify } from '$lib/server/services';
import { toResponse } from '$lib/server/http';
import { normalizePlayback, type RawPlayback } from '$lib/server/spotify/player';
import { contextInfo, trackStats } from '$lib/server/stats';
import type { PlayerStateResponse } from '$lib/shared/player-types';

/** GET /api/player/state — GET /me/player, enriched from the DB (no extra Spotify call). */
export const GET: RequestHandler = async () => {
	try {
		const { data } = await spotify().get<RawPlayback>('/me/player', { additional_types: 'episode' });
		const fetchedAt = Date.now();
		const snapshot = normalizePlayback(data);
		const sql = db();
		const [ctx, stats] = await Promise.all([
			contextInfo(sql, snapshot.context?.uri, config().ownerSpotifyId).catch(() => null),
			snapshot.item?.type === 'track' ? trackStats(sql, snapshot.item.uri).catch(() => null) : Promise.resolve(null)
		]);
		const body: PlayerStateResponse = { snapshot, contextInfo: ctx, trackStats: stats, fetchedAt };
		return json(body);
	} catch (e) {
		return toResponse(e);
	}
};
