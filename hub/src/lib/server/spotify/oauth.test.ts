import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pkceChallenge } from '$lib/server/crypto';
import {
	CRON_SCOPES,
	HUB_SCOPES,
	InvalidGrant,
	buildAuthorizeUrl,
	decodeStateCookie,
	encodeStateCookie,
	newOAuthState,
	refreshAccessToken,
	safeReturnTo
} from './oauth';
import { fakeFetch } from '$lib/server/test-helpers';

describe('authorize URL', () => {
	it('carries state, PKCE S256 and the scopes', () => {
		const st = newOAuthState('hub', '/home');
		const u = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://r.example/auth/callback', state: st, scopes: HUB_SCOPES, showDialog: true }));
		expect(u.origin + u.pathname).toBe('https://accounts.spotify.com/authorize');
		expect(u.searchParams.get('response_type')).toBe('code');
		expect(u.searchParams.get('state')).toBe(st.state);
		expect(u.searchParams.get('code_challenge_method')).toBe('S256');
		expect(u.searchParams.get('code_challenge')).toBe(pkceChallenge(st.verifier));
		expect(u.searchParams.get('scope')!.split(' ')).toEqual([...HUB_SCOPES]);
		expect(u.searchParams.get('show_dialog')).toBe('true');
	});

	it('hub scopes include what the Web Playback SDK needs', () => {
		for (const s of ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state']) expect(HUB_SCOPES).toContain(s);
		expect(HUB_SCOPES).toContain('user-library-modify'); // R2 custom playlist delete via /me/library
	});

	it('cron scopes match scripts/spotify_auth.py', () => {
		const py = readFileSync(fileURLToPath(new URL('../../../../../scripts/spotify_auth.py', import.meta.url)), 'utf8');
		const start = py.indexOf('SPOTIFY_SCOPES = (');
		const block = py.slice(start, py.indexOf('\n)', start));
		const scopes = [...block.matchAll(/^\s*"([a-z-]+)\s*"/gm)].map((m) => m[1]);
		expect(new Set(scopes)).toEqual(new Set(CRON_SCOPES));
	});
});

describe('state cookie', () => {
	it('round-trips and expires after 10 minutes', () => {
		const st = newOAuthState('cron', '/settings', 1_000_000);
		const c = encodeStateCookie(st, 'secret');
		expect(decodeStateCookie(c, 'secret', 1_000_000 + 1000)).toMatchObject({ client: 'cron', state: st.state });
		expect(decodeStateCookie(c, 'secret', 1_000_000 + 601_000)).toBeNull();
		expect(decodeStateCookie(c, 'wrong', 1_000_000)).toBeNull();
		expect(decodeStateCookie(undefined, 'secret')).toBeNull();
	});
});

describe('safeReturnTo', () => {
	it.each([
		['/daily', '/daily'],
		['/settings?x=1', '/settings?x=1'],
		['//evil.example', '/home'],
		['/\\evil.example', '/home'],
		['https://evil.example', '/home'],
		['javascript:alert(1)', '/home'],
		['/x\nSet-Cookie:', '/home'],
		[null, '/home']
	])('%s → %s', (input, out) => expect(safeReturnTo(input)).toBe(out));
});

describe('refresh', () => {
	it('maps invalid_grant to InvalidGrant (6-month expiry)', async () => {
		const { fetch } = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } }));
		await expect(refreshAccessToken('r', { clientId: 'a', clientSecret: 'b' }, fetch)).rejects.toBeInstanceOf(InvalidGrant);
	});
	it('sends Basic client auth and the refresh token', async () => {
		const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { access_token: 'at', token_type: 'Bearer', expires_in: 3600 } }));
		await refreshAccessToken('r1', { clientId: 'a', clientSecret: 'b' }, fetch);
		expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('a:b').toString('base64')}`);
		expect(calls[0]!.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1' });
	});
});
