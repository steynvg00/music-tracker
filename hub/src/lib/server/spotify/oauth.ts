/**
 * Spotify OAuth: Authorization Code with client secret (server-side) + PKCE + state.
 *
 * Two clients:
 *   'hub'  — the hub's own Spotify app. Sign-in and the player.
 *   'cron' — the existing cron app (option A). "Connect crons" in Settings mints the
 *            cron token through the hub with the cron app's credentials and the cron's
 *            scope set, so lib/spotify.py can read it from hub_oauth_tokens.
 * Both apps must list `${ORIGIN}/auth/callback` as a redirect URI.
 */
import { pkceChallenge, randomToken, sign, unsign } from '$lib/server/crypto';
import type { HubConfig } from '$lib/server/env';

export type OAuthClient = 'hub' | 'cron';

/** Player + Web Playback SDK (streaming, user-read-email, user-read-private) + Daily pick writes. */
export const HUB_SCOPES = [
	'user-read-playback-state',
	'user-modify-playback-state',
	'user-read-currently-playing',
	'streaming',
	'user-read-email',
	'user-read-private',
	'playlist-read-private',
	'playlist-read-collaborative',
	'playlist-modify-private',
	'playlist-modify-public'
] as const;

/** Must match SPOTIFY_SCOPES in scripts/spotify_auth.py. */
export const CRON_SCOPES = [
	'playlist-modify-public',
	'playlist-modify-private',
	'playlist-read-private',
	'user-library-read',
	'user-library-modify',
	'user-top-read',
	'user-read-recently-played',
	'user-follow-read',
	'playlist-read-collaborative'
] as const;

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const STATE_COOKIE = 'rotor_oauth';
export const STATE_MAX_AGE_S = 600;

export function scopesFor(client: OAuthClient): readonly string[] {
	return client === 'hub' ? HUB_SCOPES : CRON_SCOPES;
}

export function credentialsFor(client: OAuthClient, cfg: HubConfig): { clientId: string; clientSecret: string } | null {
	if (client === 'hub') return { clientId: cfg.hubClientId, clientSecret: cfg.hubClientSecret };
	if (cfg.cronClientId && cfg.cronClientSecret) return { clientId: cfg.cronClientId, clientSecret: cfg.cronClientSecret };
	return null;
}

export function isOAuthClient(v: unknown): v is OAuthClient {
	return v === 'hub' || v === 'cron';
}

/** Only same-site relative paths; everything else falls back to /home. */
export function safeReturnTo(raw: string | null | undefined, fallback = '/home'): string {
	if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.includes('://')) return fallback;
	if (/[\u0000-\u001f]/.test(raw) || raw.length > 300) return fallback;
	return raw;
}

export interface OAuthState {
	state: string;
	verifier: string;
	client: OAuthClient;
	returnTo: string;
	issuedAt: number;
}

export function newOAuthState(client: OAuthClient, returnTo: string, now = Date.now()): OAuthState {
	return { state: randomToken(24), verifier: randomToken(48), client, returnTo: safeReturnTo(returnTo), issuedAt: now };
}

export function encodeStateCookie(s: OAuthState, secret: string): string {
	return sign(Buffer.from(JSON.stringify(s)).toString('base64url'), secret);
}

export function decodeStateCookie(value: string | undefined, secret: string, now = Date.now()): OAuthState | null {
	if (!value) return null;
	const payload = unsign(value, secret);
	if (!payload) return null;
	try {
		const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
		if (!isOAuthClient(s.client) || typeof s.state !== 'string' || typeof s.verifier !== 'string') return null;
		if (now - s.issuedAt > STATE_MAX_AGE_S * 1000 || s.issuedAt > now + 60_000) return null;
		return { ...s, returnTo: safeReturnTo(s.returnTo) };
	} catch {
		return null;
	}
}

export function buildAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: OAuthState;
	scopes: readonly string[];
	showDialog: boolean;
}): string {
	const u = new URL(AUTHORIZE_URL);
	u.searchParams.set('client_id', opts.clientId);
	u.searchParams.set('response_type', 'code');
	u.searchParams.set('redirect_uri', opts.redirectUri);
	u.searchParams.set('state', opts.state.state);
	u.searchParams.set('scope', opts.scopes.join(' '));
	u.searchParams.set('code_challenge_method', 'S256');
	u.searchParams.set('code_challenge', pkceChallenge(opts.state.verifier));
	if (opts.showDialog) u.searchParams.set('show_dialog', 'true');
	return u.toString();
}

export interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	scope?: string;
	refresh_token?: string;
}

export class InvalidGrant extends Error {
	constructor(readonly description: string) {
		super(`invalid_grant: ${description}`);
		this.name = 'InvalidGrant';
	}
}

async function tokenRequest(
	params: Record<string, string>,
	creds: { clientId: string; clientSecret: string },
	f: typeof fetch
): Promise<TokenResponse> {
	const res = await f(TOKEN_URL, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams(params).toString(),
		signal: AbortSignal.timeout(8000)
	});
	const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
	if (!res.ok) {
		if (body.error === 'invalid_grant') throw new InvalidGrant(body.error_description ?? '');
		throw new Error(`Spotify token endpoint ${res.status}: ${body.error ?? 'error'}`);
	}
	if (!body.access_token || !body.expires_in) throw new Error('Spotify token endpoint returned no access token');
	return body as TokenResponse;
}

export function exchangeCode(
	opts: { code: string; verifier: string; redirectUri: string },
	creds: { clientId: string; clientSecret: string },
	f: typeof fetch = fetch
): Promise<TokenResponse> {
	return tokenRequest(
		{ grant_type: 'authorization_code', code: opts.code, redirect_uri: opts.redirectUri, code_verifier: opts.verifier },
		creds,
		f
	);
}

export function refreshAccessToken(
	refreshToken: string,
	creds: { clientId: string; clientSecret: string },
	f: typeof fetch = fetch
): Promise<TokenResponse> {
	return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, creds, f);
}

export async function fetchMe(accessToken: string, f: typeof fetch = fetch): Promise<{ id: string; display_name?: string | null }> {
	const res = await f('https://api.spotify.com/v1/me', {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(8000)
	});
	if (!res.ok) throw new Error(`GET /me failed: ${res.status}`);
	return (await res.json()) as { id: string; display_name?: string | null };
}
