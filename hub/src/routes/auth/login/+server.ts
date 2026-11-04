import { redirect, type RequestHandler } from '@sveltejs/kit';
import { config, redirectUri } from '$lib/server/env';
import { startAuthorization } from '$lib/server/auth-flow';
import { isOAuthClient, STATE_COOKIE, STATE_MAX_AGE_S } from '$lib/server/spotify/oauth';

/**
 * GET /auth/login?client=hub|cron[&reconnect=1][&next=/path]
 * Starts Spotify OAuth. client=cron ("Connect crons", option A) needs a signed-in owner.
 */
export const GET: RequestHandler = ({ url, cookies, locals }) => {
	const client = url.searchParams.get('client') ?? 'hub';
	if (!isOAuthClient(client)) redirect(303, '/login?error=state');
	if (client === 'cron' && !locals.session) redirect(303, '/login?error=session');

	const cfg = config();
	const res = startAuthorization(cfg, redirectUri(cfg), {
		client,
		returnTo: url.searchParams.get('next') ?? (client === 'cron' ? '/settings' : '/home'),
		// Always show Spotify's dialog for Reconnect and for the cron app, so you see which app you approve.
		showDialog: client === 'cron' || url.searchParams.get('reconnect') === '1'
	});
	if ('error' in res) redirect(303, `/settings?error=${res.error}`);

	cookies.set(STATE_COOKIE, res.stateCookie, {
		path: '/auth',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'lax',
		maxAge: STATE_MAX_AGE_S
	});
	redirect(302, res.authorizeUrl);
};
