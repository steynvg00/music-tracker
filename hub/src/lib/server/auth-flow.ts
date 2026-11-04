/**
 * Sign-in / Reconnect orchestration, kept free of SvelteKit so it is unit-tested
 * (auth-flow.test.ts): the owner gate rejects every Spotify account except
 * OWNER_SPOTIFY_ID *before* anything is stored or a session exists.
 */
import type { Sql } from '$lib/server/db';
import type { HubConfig } from '$lib/server/env';
import { createSession } from '$lib/server/session';
import {
	buildAuthorizeUrl,
	credentialsFor,
	decodeStateCookie,
	encodeStateCookie,
	exchangeCode,
	fetchMe,
	newOAuthState,
	scopesFor,
	type OAuthClient
} from './spotify/oauth';
import { saveAuthorization } from './spotify/token';

export interface StartResult {
	authorizeUrl: string;
	stateCookie: string;
}

export function startAuthorization(
	cfg: HubConfig,
	redirectUri: string,
	opts: { client: OAuthClient; returnTo: string; showDialog: boolean }
): StartResult | { error: 'cron_not_configured' } {
	const creds = credentialsFor(opts.client, cfg);
	if (!creds) return { error: 'cron_not_configured' };
	const state = newOAuthState(opts.client, opts.returnTo);
	return {
		authorizeUrl: buildAuthorizeUrl({
			clientId: creds.clientId,
			redirectUri,
			state,
			scopes: scopesFor(opts.client),
			showDialog: opts.showDialog
		}),
		stateCookie: encodeStateCookie(state, cfg.sessionSecret)
	};
}

export interface CallbackInput {
	code: string | null;
	state: string | null;
	error: string | null;
	stateCookie: string | undefined;
	hasSession: boolean;
	userAgent: string | null;
}

export interface CallbackDeps {
	cfg: HubConfig;
	sql: Sql;
	key: Buffer;
	redirectUri: string;
	fetch?: typeof fetch;
}

export interface CallbackResult {
	redirect: string;
	/** Raw session id to set as cookie (new sign-in only). */
	sessionRaw?: string;
}

const fail = (code: string, client: OAuthClient | null = null): CallbackResult =>
	client === 'cron' ? { redirect: `/settings?error=${code}` } : { redirect: `/login?error=${code}` };

export async function finishAuthorization(deps: CallbackDeps, input: CallbackInput): Promise<CallbackResult> {
	const st = decodeStateCookie(input.stateCookie, deps.cfg.sessionSecret);
	if (!st || !input.state || st.state !== input.state) return fail('state');
	if (input.error) return fail(input.error === 'access_denied' ? 'denied' : 'spotify', st.client);
	if (!input.code) return fail('state', st.client);
	if (st.client === 'cron' && !input.hasSession) return fail('session');

	const creds = credentialsFor(st.client, deps.cfg);
	if (!creds) return fail('cron_not_configured', st.client);

	let token;
	try {
		token = await exchangeCode({ code: input.code, verifier: st.verifier, redirectUri: deps.redirectUri }, creds, deps.fetch);
	} catch {
		return fail('exchange', st.client);
	}

	let me;
	try {
		me = await fetchMe(token.access_token, deps.fetch);
	} catch {
		return fail('exchange', st.client);
	}
	// Owner gate. Development Mode's 5-user allowlist is the second gate.
	if (me.id !== deps.cfg.ownerSpotifyId) return fail('not_owner', st.client);

	await saveAuthorization(deps.sql, deps.key, {
		client: st.client,
		accountId: me.id,
		spotifyClientId: creds.clientId,
		token
	});

	if (st.client === 'cron') return { redirect: '/settings?connected=cron' };
	if (input.hasSession) return { redirect: st.returnTo };
	const sessionRaw = await createSession(deps.sql, deps.cfg.sessionSecret, input.userAgent);
	return { redirect: st.returnTo, sessionRaw };
}
