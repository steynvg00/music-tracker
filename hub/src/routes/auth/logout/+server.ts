import { redirect, type RequestHandler } from '@sveltejs/kit';
import { config } from '$lib/server/env';
import { db } from '$lib/server/db';
import { clearSessionCookie, deleteAllSessions, deleteSession, SESSION_COOKIE } from '$lib/server/session';

/** POST /auth/logout (form). Field everywhere=1 → "Sign out everywhere" (deletes every session). */
export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const form = await request.formData().catch(() => null);
	const sql = db();
	if (form?.get('everywhere') === '1') await deleteAllSessions(sql);
	else await deleteSession(sql, config().sessionSecret, cookies.get(SESSION_COOKIE));
	clearSessionCookie(cookies, url.protocol === 'https:');
	redirect(303, '/login?signed_out=1');
};
