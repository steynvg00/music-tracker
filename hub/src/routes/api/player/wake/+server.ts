import { json, type RequestHandler } from '@sveltejs/kit';
import type { Config } from '@sveltejs/adapter-vercel';
import { db } from '$lib/server/db';
import { config as hubConfig } from '$lib/server/env';
import { spotify, writeGuard } from '$lib/server/services';
import { apiError, readJson, toResponse } from '$lib/server/http';
import { buildCommand, normalizeDevice } from '$lib/server/spotify/player';
import { playCandidate } from '$lib/server/daily';
import { wakeAndRun } from '$lib/server/wake';
import { isIsoDate } from '$lib/server/time';

export const config: Config = { maxDuration: 30 };

/**
 * POST /api/player/wake
 *   { intent: { type: 'play', body: {...} } | { type: 'daily', date, rank },
 *     prefer?: 'Smartphone' | 'Computer' | …, known_ids?: string[] }
 * → 200 { status: 'played', device } | { status: 'timeout' }
 */
export const POST: RequestHandler = async ({ request }) => {
	const input = await readJson(request);
	const intent = (input.intent ?? {}) as Record<string, unknown>;
	const prefer = typeof input.prefer === 'string' ? input.prefer.slice(0, 32) : null;
	const knownIds = Array.isArray(input.known_ids) ? input.known_ids.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];

	let run: (deviceId: string) => Promise<void>;
	try {
		if (intent.type === 'play') {
			const body = (intent.body ?? {}) as Record<string, unknown>;
			buildCommand('play', body); // validate before waiting
			run = async (deviceId) => {
				const call = buildCommand('play', { ...body, device_id: deviceId });
				await spotify().request(call.method, call.path, { query: call.query, body: call.body });
			};
		} else if (intent.type === 'daily' && isIsoDate(intent.date) && typeof intent.rank === 'number') {
			const date = intent.date;
			const rank = intent.rank;
			const offset = typeof intent.offset === 'number' && Number.isInteger(intent.offset) && intent.offset >= 0 && intent.offset < 500 ? intent.offset : 0;
			run = async (deviceId) => {
				await playCandidate(
					{ sql: db(), api: spotify(), guard: writeGuard(), ownerId: hubConfig().ownerSpotifyId },
					{ date, rank, deviceId, offset }
				);
			};
		} else {
			return apiError(400, { error: 'bad_request', message: 'intent must be play or daily' });
		}
	} catch (e) {
		return toResponse(e);
	}

	try {
		const result = await wakeAndRun({
			listDevices: async () => {
				const { data } = await spotify().get<{ devices: Parameters<typeof normalizeDevice>[0][] }>('/me/player/devices');
				return (data?.devices ?? []).map(normalizeDevice);
			},
			run,
			prefer,
			knownIds
		});
		return json(result);
	} catch (e) {
		return toResponse(e);
	}
};
