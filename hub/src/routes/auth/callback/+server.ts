import { redirect, type RequestHandler } from '@sveltejs/kit';
import { config, redirectUri } from '$lib/server/env';
import { db } from '$lib/server/db';
import { finishAuthorization } from '$lib/server/auth-flow';
import { tokenKey, tokenProvider } from '$lib/server/services';
import { setSessionCookie } from '$lib/server/session';
import { STATE_COOKIE } from '$lib/server/spotify/oauth';

/** GET /auth/callback — Spotify redirects here (register ORIGIN/auth/callback in both apps). */
export const GET: RequestHandler = async ({ url, cookies, locals, request }) => {
	const cfg = config();
	const stateCookie = cookies.get(STATE_COOKIE);
	cookies.delete(STATE_COOKIE, { path: '/auth', secure: url.protocol === 'https:' });

	const result = await finishAuthorization(
		{ cfg, sql: db(), key: tokenKey(), redirectUri: redirectUri(cfg) },
		{
			code: url.searchParams.get('code'),
			state: url.searchParams.get('state'),
			error: url.searchParams.get('error'),
			stateCookie,
			hasSession: !!locals.session,
			userAgent: request.headers.get('user-agent')
		}
	);
	if (result.sessionRaw) setSessionCookie(cookies, result.sessionRaw, url.protocol === 'https:');
	// A fresh authorization replaced the stored token: drop this lambda's cached access token.
	tokenProvider().forget('hub');
	redirect(303, result.redirect);
};
