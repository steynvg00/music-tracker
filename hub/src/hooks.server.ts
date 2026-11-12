import { json, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { SESSION_COOKIE, setSessionCookie, validateSession } from '$lib/server/session';
import { isPublicPath, originAllowed } from '$lib/server/access';
import { serverTiming, withTimings } from '$lib/server/timing';

/** v0.92: every response carries Server-Timing (db / spotify / total) for the speed work. */
export const handle: Handle = async (input) => {
	const { t, result } = withTimings(() => handleInner(input));
	const response = await result;
	try {
		response.headers.set('Server-Timing', serverTiming(t));
	} catch {
		/* immutable headers (redirect / fetch passthrough) */
	}
	return response;
};

const handleInner: Handle = async ({ event, resolve }) => {
	const { url, request, cookies } = event;

	// Origin check for every mutating request (JSON APIs aren't covered by SvelteKit's
	// form-only CSRF check). Requests without an Origin header are refused too.
	if (!originAllowed(request.method, request.headers.get('origin'), url.origin)) {
		return json({ error: 'bad_origin' }, { status: 403 });
	}

	event.locals.session = null;
	const raw = cookies.get(SESSION_COOKIE);
	if (raw) {
		const cfg = config();
		event.locals.session = await validateSession(db(), cfg.sessionSecret, raw);
		if (event.locals.session?.touched) setSessionCookie(cookies, raw, url.protocol === 'https:');
	}

	if (!event.locals.session && !isPublicPath(url.pathname)) {
		if (url.pathname.startsWith('/api/')) {
			return json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
		}
		const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
		redirect(303, `/login${next}`);
	}

	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	if (url.pathname.startsWith('/api/') && !response.headers.has('Cache-Control')) {
		response.headers.set('Cache-Control', 'no-store');
	}
	return response;
};

export const handleError: HandleServerError = ({ error, status }) => {
	if (status !== 404) console.error('[rotor]', error);
	const code = error instanceof Error && error.name === 'ConfigError' ? 'config' : undefined;
	return { message: status === 404 ? 'Not found' : 'Something went wrong', code };
};
