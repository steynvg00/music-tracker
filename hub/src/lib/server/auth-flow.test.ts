import { describe, expect, it } from 'vitest';
import { finishAuthorization, startAuthorization } from './auth-flow';
import { encodeStateCookie, newOAuthState } from './spotify/oauth';
import { fakeFetch, fakeSql } from './test-helpers';
import type { HubConfig } from './env';

const cfg: HubConfig = {
	origin: 'https://rotor.example',
	hubClientId: 'hub-app',
	hubClientSecret: 'hub-secret',
	cronClientId: 'cron-app',
	cronClientSecret: 'cron-secret',
	ownerSpotifyId: 'owner',
	databaseUrl: 'postgres://x',
	sessionSecret: 'session-secret',
	tokenEncKey: Buffer.alloc(32, 1).toString('base64'),
	githubDispatchToken: null,
	githubRepository: 'steynvg00/music-tracker',
	vapidPublicKey: null,
	youtubeApiKey: null
};
const key = Buffer.alloc(32, 1);
const REDIRECT = 'https://rotor.example/auth/callback';

function spotify(meId: string) {
	return fakeFetch((req) => {
		if (req.url.href === 'https://accounts.spotify.com/api/token') {
			return { status: 200, body: { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt', scope: 'streaming' } };
		}
		if (req.url.href === 'https://api.spotify.com/v1/me') return { status: 200, body: { id: meId } };
		return undefined;
	});
}

function run(opts: { meId: string; client?: 'hub' | 'cron'; hasSession?: boolean; state?: string; error?: string | null }) {
	const st = newOAuthState(opts.client ?? 'hub', '/daily');
	const { sql, queries } = fakeSql(() => []);
	const sp = spotify(opts.meId);
	const result = finishAuthorization(
		{ cfg, sql, key, redirectUri: REDIRECT, fetch: sp.fetch },
		{
			code: 'code',
			state: opts.state ?? st.state,
			error: opts.error ?? null,
			stateCookie: encodeStateCookie(st, cfg.sessionSecret),
			hasSession: opts.hasSession ?? false,
			userAgent: 'test'
		}
	);
	return { result, queries, calls: sp.calls, st };
}

describe('owner gate', () => {
	it('rejects a non-owner account after OAuth: nothing stored, no session (smoke 1)', async () => {
		const r = run({ meId: 'someone-else' });
		expect(await r.result).toEqual({ redirect: '/login?error=not_owner' });
		expect(r.queries).toHaveLength(0);
	});

	it('signs the owner in: token row saved, session created', async () => {
		const r = run({ meId: 'owner' });
		const res = await r.result;
		expect(res.redirect).toBe('/daily');
		expect(res.sessionRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const insert = r.queries.find((q) => q.text.startsWith('INSERT INTO hub_oauth_tokens'))!;
		expect(insert.values.slice(0, 3)).toEqual(['hub', 'owner', 'hub-app']);
		// Stored encrypted, never in clear.
		expect(insert.values.some((v) => v === 'rt' || v === 'at')).toBe(false);
		expect(r.queries.some((q) => q.text.startsWith('INSERT INTO hub_sessions'))).toBe(true);
	});

	it('exchanges the code with PKCE verifier and the hub app credentials', async () => {
		const r = run({ meId: 'owner' });
		await r.result;
		const tok = r.calls.find((c) => c.url.href.endsWith('/api/token'))!;
		expect(tok.body).toMatchObject({ grant_type: 'authorization_code', code: 'code', redirect_uri: REDIRECT, code_verifier: r.st.verifier });
		expect(tok.headers.Authorization).toBe(`Basic ${Buffer.from('hub-app:hub-secret').toString('base64')}`);
	});
});

describe('state and errors', () => {
	it('a mismatched state is refused before any Spotify call', async () => {
		const r = run({ meId: 'owner', state: 'forged' });
		expect(await r.result).toEqual({ redirect: '/login?error=state' });
		expect(r.calls).toHaveLength(0);
	});
	it('access_denied → /login?error=denied', async () => {
		expect((await run({ meId: 'owner', error: 'access_denied' }).result).redirect).toBe('/login?error=denied');
	});
});

describe('Connect crons (option A)', () => {
	it('needs a signed-in session', async () => {
		const r = run({ meId: 'owner', client: 'cron', hasSession: false });
		expect((await r.result).redirect).toBe('/login?error=session');
		expect(r.calls).toHaveLength(0);
	});
	it('stores the cron row with the cron app id and creates no session', async () => {
		const r = run({ meId: 'owner', client: 'cron', hasSession: true });
		const res = await r.result;
		expect(res).toEqual({ redirect: '/settings?connected=cron' });
		const insert = r.queries.find((q) => q.text.startsWith('INSERT INTO hub_oauth_tokens'))!;
		expect(insert.values.slice(0, 3)).toEqual(['cron', 'owner', 'cron-app']);
		const tok = r.calls.find((c) => c.url.href.endsWith('/api/token'))!;
		expect(tok.headers.Authorization).toBe(`Basic ${Buffer.from('cron-app:cron-secret').toString('base64')}`);
	});
	it('without cron credentials configured, start refuses', () => {
		expect(startAuthorization({ ...cfg, cronClientId: null }, REDIRECT, { client: 'cron', returnTo: '/settings', showDialog: true })).toEqual({
			error: 'cron_not_configured'
		});
	});
});
