import { json } from '@sveltejs/kit';
import { SpotifyError, GuardBypassError } from '$lib/server/spotify/api';
import { ReauthRequired } from '$lib/server/spotify/token';
import { ReadOnlyPlaylist } from '$lib/server/spotify/write-guard';
import { BadCommand } from '$lib/server/spotify/player';
import { BadInput } from '$lib/shared/custom';
import { JobsUnavailable, RetryRefused } from '$lib/server/jobs';
import { ElsewhereUnavailable } from '$lib/server/elsewhere';
import type { ApiError } from '$lib/shared/player-types';

export function apiError(status: number, body: ApiError, headers: Record<string, string> = {}): Response {
	return json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** Translate server errors into the API error contract the client store understands. */
export function toResponse(e: unknown): Response {
	if (e instanceof ReauthRequired) return apiError(401, { error: 'reauth_required', reason: e.detail });
	if (e instanceof ReadOnlyPlaylist) return apiError(403, { error: 'read_only_playlist', reason: e.reason });
	if (e instanceof GuardBypassError) return apiError(500, { error: 'guard_bypass' });
	if (e instanceof BadCommand || e instanceof BadInput) return apiError(400, { error: 'bad_request', message: e.message });
	if (e instanceof JobsUnavailable) return apiError(409, { error: 'jobs_unavailable', message: e.message });
	if (e instanceof ElsewhereUnavailable) return apiError(503, { error: 'source_unavailable', message: e.message });
	if (e instanceof RetryRefused) return apiError(409, { error: 'retry_refused', reason: e.reason });
	if (e instanceof SpotifyError) {
		const headers: Record<string, string> = {};
		if (e.retryAfterS !== null) headers['Retry-After'] = String(e.retryAfterS);
		const error =
			e.status === 404 && e.reason === 'NO_ACTIVE_DEVICE'
				? 'no_active_device'
				: e.status === 403 && e.reason === 'PREMIUM_REQUIRED'
					? 'premium_required'
					: e.status === 429
						? 'rate_limited'
						: 'spotify_error';
		const status = e.status >= 400 && e.status < 600 ? e.status : 502;
		return apiError(status, { error, reason: e.reason, retryAfter: e.retryAfterS, message: e.message }, headers);
	}
	if (e instanceof Error && e.name === 'TimeoutError') return apiError(504, { error: 'spotify_timeout' });
	console.error('[rotor] unexpected error', e);
	return apiError(500, { error: 'internal' });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.headers.get('content-type')?.includes('application/json')) return {};
	try {
		const v = (await request.json()) as unknown;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
