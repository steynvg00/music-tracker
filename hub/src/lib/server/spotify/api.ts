/**
 * Minimal Spotify Web API client (server only).
 *
 * Built against the restricted Feb 2026 Development Mode endpoint set: the hub has its
 * own Client ID, which gets that set immediately. R1 uses only /me, /me/player/*,
 * /me/playlists, GET /playlists/{id}, GET|PUT|POST|DELETE /playlists/{id}/items,
 * PUT /playlists/{id}, POST /me/playlists and /me/library (unfollow).
 *
 * Every mutating call on a playlist path is refused by request(): those go through
 * write-guard.ts only (hard rule: unmanaged playlists are read + play only).
 */

import { record } from '$lib/server/timing';

export const SPOTIFY_API = 'https://api.spotify.com/v1';

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

export class SpotifyError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string | null,
		message: string,
		readonly retryAfterS: number | null = null
	) {
		super(message);
		this.name = 'SpotifyError';
	}
}

export class GuardBypassError extends Error {
	constructor(method: string, path: string) {
		super(`${method} ${path}: playlist writes must go through write-guard.ts`);
		this.name = 'GuardBypassError';
	}
}

const PLAYLIST_PATH = /^\/(?:playlists\/|me\/playlists(?:[/?]|$)|users\/[^/]+\/playlists|me\/library(?:[/?]|$))/;

export function isPlaylistWrite(method: HttpMethod, path: string): boolean {
	return method !== 'GET' && PLAYLIST_PATH.test(path);
}

export interface RequestOptions {
	query?: Record<string, string | number | boolean | undefined | null>;
	body?: unknown;
	timeoutMs?: number;
}

export interface SpotifyResponse<T> {
	status: number;
	data: T | null;
}

export interface SpotifyApiOptions {
	getToken: () => Promise<string>;
	/** Called once on a 401 before retrying with a fresh token. */
	invalidateToken?: () => void;
	fetch?: typeof fetch;
	base?: string;
}

function buildUrl(base: string, path: string, query?: RequestOptions['query']): string {
	const url = new URL(base + path);
	for (const [k, v] of Object.entries(query ?? {})) {
		if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
	}
	return url.toString();
}

async function parseError(res: Response): Promise<SpotifyError> {
	let reason: string | null = null;
	let message = `Spotify ${res.status}`;
	try {
		const body = (await res.json()) as { error?: { message?: string; reason?: string } | string; reason?: string };
		if (typeof body.error === 'object' && body.error) {
			reason = body.error.reason ?? null;
			message = body.error.message ?? message;
		} else if (typeof body.error === 'string') {
			reason = body.error;
		}
		reason = reason ?? body.reason ?? null;
	} catch {
		/* empty or non-JSON body */
	}
	const ra = res.headers.get('retry-after');
	const retryAfter = ra && /^\d+$/.test(ra) ? Number(ra) : null;
	return new SpotifyError(res.status, reason, message, retryAfter);
}

export class SpotifyApi {
	readonly #opts: SpotifyApiOptions;

	constructor(opts: SpotifyApiOptions) {
		this.#opts = opts;
	}

	get<T>(path: string, query?: RequestOptions['query']): Promise<SpotifyResponse<T>> {
		return this.request<T>('GET', path, { query });
	}

	/** Any call except playlist writes. */
	request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<SpotifyResponse<T>> {
		if (isPlaylistWrite(method, path)) throw new GuardBypassError(method, path);
		return this.#send<T>(method, path, opts, false);
	}

	/**
	 * @internal Playlist writes. ONLY write-guard.ts may call this, after its live
	 * owner + suffix check. write-guard.test.ts fails if any other file references it.
	 */
	_sendPlaylistWrite<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<SpotifyResponse<T>> {
		if (!isPlaylistWrite(method, path)) throw new Error(`${method} ${path} is not a playlist write`);
		return this.#send<T>(method, path, opts, false);
	}

	async #send<T>(method: HttpMethod, path: string, opts: RequestOptions, retried: boolean): Promise<SpotifyResponse<T>> {
		const f = this.#opts.fetch ?? fetch;
		const token = await this.#opts.getToken();
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		let body: string | undefined;
		if (opts.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(opts.body);
		}
		const t0 = performance.now();
		const res = await f(buildUrl(this.#opts.base ?? SPOTIFY_API, path, opts.query), {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 8000)
		}).finally(() => record('spotify', performance.now() - t0));
		if (res.status === 401 && !retried && this.#opts.invalidateToken) {
			this.#opts.invalidateToken();
			return this.#send<T>(method, path, opts, true);
		}
		if (!res.ok) throw await parseError(res);
		if (res.status === 204 || res.status === 202) return { status: res.status, data: null };
		const text = await res.text();
		if (!text) return { status: res.status, data: null };
		try {
			return { status: res.status, data: JSON.parse(text) as T };
		} catch {
			// Some player endpoints answer 200 with a non-JSON snapshot id.
			return { status: res.status, data: null };
		}
	}
}

export const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
export const TRACK_URI = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;
export const CONTEXT_URI = /^spotify:(playlist|album|artist|show):[A-Za-z0-9]{22}$|^spotify:user:[^:\s]{1,64}:collection$/;
export const PLAYABLE_URI = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;

export function playlistIdFromUri(uri: string | null | undefined): string | null {
	const m = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(uri ?? '');
	return m?.[1] ?? null;
}
