/** Browser → Rotor API. The browser never talks to Spotify's Web API directly. */
import type { ApiError } from '$lib/shared/player-types';

export class ApiFailure extends Error {
	constructor(
		readonly status: number,
		readonly body: ApiError
	) {
		super(body.message ?? body.error);
		this.name = 'ApiFailure';
	}
	get retryAfterS(): number | null {
		return this.body.retryAfter ?? null;
	}
}

async function handle<T>(res: Response): Promise<T> {
	if (res.status === 204) return undefined as T;
	const body = (await res.json().catch(() => ({ error: 'bad_response' }))) as T & ApiError;
	if (!res.ok) throw new ApiFailure(res.status, body as ApiError);
	return body;
}

export async function apiGet<T>(path: string, f: typeof fetch = fetch): Promise<T> {
	return handle<T>(await f(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }));
}

export async function apiPost<T>(path: string, body: unknown = {}, opts: { keepalive?: boolean; f?: typeof fetch } = {}): Promise<T> {
	const f = opts.f ?? fetch;
	return handle<T>(
		await f(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify(body),
			credentials: 'same-origin',
			keepalive: opts.keepalive
		})
	);
}

/** Human message for a failed call (toasts). */
export function describeFailure(e: unknown): string {
	if (!(e instanceof ApiFailure)) return 'Rotor lost the connection. Try again.';
	switch (e.body.error) {
		case 'reauth_required':
			return 'Reconnect Spotify in Settings.';
		case 'no_active_device':
			return 'No active Spotify device.';
		case 'premium_required':
			return 'Spotify Premium is required for remote control.';
		case 'rate_limited':
			return 'Spotify is rate-limiting Rotor. Try again in a moment.';
		case 'read_only_playlist':
			return 'That playlist is read + play only.';
		case 'spotify_error':
			return e.status === 403 ? 'Spotify doesn’t allow that right now.' : 'Spotify refused that command.';
		default:
			return 'Something went wrong. Try again.';
	}
}
