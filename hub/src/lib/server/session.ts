import type { Cookies } from '@sveltejs/kit';
import type { Queryable } from '$lib/server/db';
import { hmac, randomToken } from '$lib/server/crypto';

/**
 * Single-user sessions. The cookie holds 256 random bits; the DB stores only
 * HMAC-SHA256(SESSION_SECRET, cookie), so neither a DB leak nor a leaked secret alone
 * yields a session. 30 days, sliding: last_seen_at (and the cookie) are renewed at most
 * every 12 hours.
 */
export const SESSION_COOKIE = 'rotor_session';
export const SESSION_DAYS = 30;
const TOUCH_AFTER_MS = 12 * 3600 * 1000;

export function hashSessionId(raw: string, secret: string): Buffer {
	return hmac(secret, `rotor-session:${raw}`);
}

export function sessionCookieOptions(secure: boolean) {
	return {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax' as const,
		maxAge: SESSION_DAYS * 24 * 3600
	};
}

export async function createSession(sql: Queryable, secret: string, userAgent: string | null): Promise<string> {
	const raw = randomToken(32);
	await sql`DELETE FROM hub_sessions WHERE last_seen_at < now() - make_interval(days => ${SESSION_DAYS})`;
	await sql`
		INSERT INTO hub_sessions (id_hash, user_agent)
		VALUES (${hashSessionId(raw, secret)}, ${userAgent?.slice(0, 300) ?? null})`;
	return raw;
}

export interface SessionInfo {
	idHash: Buffer;
	createdAt: Date;
	touched: boolean;
}

export async function validateSession(
	sql: Queryable,
	secret: string,
	raw: string | undefined,
	now: Date = new Date()
): Promise<SessionInfo | null> {
	if (!raw || raw.length < 40 || raw.length > 64) return null;
	const idHash = hashSessionId(raw, secret);
	const rows = await sql<{ created_at: Date; last_seen_at: Date }[]>`
		SELECT created_at, last_seen_at FROM hub_sessions
		WHERE id_hash = ${idHash} AND last_seen_at > now() - make_interval(days => ${SESSION_DAYS})`;
	const row = rows[0];
	if (!row) return null;
	const touched = now.getTime() - new Date(row.last_seen_at).getTime() > TOUCH_AFTER_MS;
	if (touched) await sql`UPDATE hub_sessions SET last_seen_at = now() WHERE id_hash = ${idHash}`;
	return { idHash, createdAt: new Date(row.created_at), touched };
}

export async function deleteSession(sql: Queryable, secret: string, raw: string | undefined): Promise<void> {
	if (!raw) return;
	await sql`DELETE FROM hub_sessions WHERE id_hash = ${hashSessionId(raw, secret)}`;
}

/** "Sign out everywhere". */
export async function deleteAllSessions(sql: Queryable): Promise<number> {
	const res = await sql`DELETE FROM hub_sessions`;
	return res.count;
}

export function setSessionCookie(cookies: Cookies, raw: string, secure: boolean): void {
	cookies.set(SESSION_COOKIE, raw, sessionCookieOptions(secure));
}

export function clearSessionCookie(cookies: Cookies, secure: boolean): void {
	cookies.delete(SESSION_COOKIE, { path: '/', secure });
}
