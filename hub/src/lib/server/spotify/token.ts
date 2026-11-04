/**
 * Encrypted token store (hub_oauth_tokens, migration 0019) and access-token refresh.
 *
 * - Access tokens are cached in lambda memory and, encrypted, in the DB, so parallel
 *   lambdas don't each refresh. A refresh runs under `SELECT … FOR UPDATE SKIP LOCKED`.
 * - A rotated refresh token is stored; authorized_at is NEVER moved by a refresh
 *   (Spotify: the 6-month lifetime counts from the original authorization).
 * - invalid_grant → last_error is written and ReauthRequired is thrown; the UI shows
 *   "Reconnect Spotify".
 */
import type { Queryable, Sql } from '$lib/server/db';
import { aadFor, decrypt, encrypt } from '$lib/server/crypto';
import { InvalidGrant, refreshAccessToken, type OAuthClient, type TokenResponse } from './oauth';

export const TOKEN_LIFETIME_MONTHS = 6;
export const WARN_DAYS = 21;
export const DANGER_DAYS = 7;
const EARLY_REFRESH_MS = 2 * 60 * 1000;

export class ReauthRequired extends Error {
	constructor(
		readonly client: OAuthClient,
		readonly detail: 'missing' | 'invalid_grant' | 'client_mismatch' | 'busy'
	) {
		super(`Spotify reconnect required (${client}: ${detail})`);
		this.name = 'ReauthRequired';
	}
}

/** authorized_at + 6 calendar months (day clamped, e.g. 31 Aug → 28/29 Feb). */
export function expiresAt(authorizedAt: Date): Date {
	const d = new Date(authorizedAt.getTime());
	const day = d.getUTCDate();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + TOKEN_LIFETIME_MONTHS);
	const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	d.setUTCDate(Math.min(day, last));
	return d;
}

export function daysLeft(authorizedAt: Date, now: Date = new Date()): number {
	return Math.floor((expiresAt(authorizedAt).getTime() - now.getTime()) / 86_400_000);
}

export type Health = 'ok' | 'warn' | 'danger';

export function tokenHealth(days: number | null, lastError: string | null): Health {
	if (days === null || lastError === 'invalid_grant' || days <= DANGER_DAYS) return 'danger';
	if (days <= WARN_DAYS) return 'warn';
	return 'ok';
}

export interface ConnectionStatus {
	client: OAuthClient;
	connected: boolean;
	accountId: string | null;
	spotifyClientId: string | null;
	authorizedAt: string | null;
	expiresAt: string | null;
	daysLeft: number | null;
	lastRefreshAt: string | null;
	lastError: string | null;
	scopes: string[];
	health: Health;
}

export async function connectionStatus(sql: Queryable, now: Date = new Date()): Promise<Record<OAuthClient, ConnectionStatus>> {
	const rows = await sql<
		{
			client: OAuthClient;
			account_id: string;
			spotify_client_id: string;
			authorized_at: Date;
			last_refresh_at: Date | null;
			last_error: string | null;
			scopes: string;
		}[]
	>`SELECT client, account_id, spotify_client_id, authorized_at, last_refresh_at, last_error, scopes FROM hub_oauth_tokens`;
	const out = {} as Record<OAuthClient, ConnectionStatus>;
	for (const client of ['hub', 'cron'] as const) {
		const r = rows.find((x) => x.client === client);
		const d = r ? daysLeft(new Date(r.authorized_at), now) : null;
		out[client] = {
			client,
			connected: !!r,
			accountId: r?.account_id ?? null,
			spotifyClientId: r?.spotify_client_id ?? null,
			authorizedAt: r ? new Date(r.authorized_at).toISOString() : null,
			expiresAt: r ? expiresAt(new Date(r.authorized_at)).toISOString() : null,
			daysLeft: d,
			lastRefreshAt: r?.last_refresh_at ? new Date(r.last_refresh_at).toISOString() : null,
			lastError: r?.last_error ?? null,
			scopes: r ? r.scopes.split(' ').filter(Boolean) : [],
			health: r ? tokenHealth(d, r.last_error) : client === 'hub' ? 'danger' : 'ok'
		};
	}
	return out;
}

/** After a successful code exchange: new authorization, so authorized_at = now(). */
export async function saveAuthorization(
	sql: Queryable,
	key: Buffer,
	a: { client: OAuthClient; accountId: string; spotifyClientId: string; token: TokenResponse }
): Promise<void> {
	if (!a.token.refresh_token) throw new Error('Spotify returned no refresh token');
	const refreshEnc = encrypt(a.token.refresh_token, key, aadFor(a.client, 'refresh_token'));
	const accessEnc = encrypt(a.token.access_token, key, aadFor(a.client, 'access_token'));
	const expires = new Date(Date.now() + a.token.expires_in * 1000);
	await sql`
		INSERT INTO hub_oauth_tokens (client, provider, account_id, spotify_client_id, refresh_token_enc,
			access_token_enc, access_expires_at, scopes, authorized_at, last_refresh_at, last_error, last_error_at, updated_at)
		VALUES (${a.client}, 'spotify', ${a.accountId}, ${a.spotifyClientId}, ${refreshEnc},
			${accessEnc}, ${expires}, ${a.token.scope ?? ''}, now(), now(), NULL, NULL, now())
		ON CONFLICT (client) DO UPDATE SET
			account_id = EXCLUDED.account_id, spotify_client_id = EXCLUDED.spotify_client_id,
			refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc,
			access_expires_at = EXCLUDED.access_expires_at, scopes = EXCLUDED.scopes,
			authorized_at = EXCLUDED.authorized_at, last_refresh_at = EXCLUDED.last_refresh_at,
			last_error = NULL, last_error_at = NULL, updated_at = now()`;
}

interface Row {
	spotify_client_id: string;
	refresh_token_enc: Uint8Array;
	access_token_enc: Uint8Array | null;
	access_expires_at: Date | null;
}

export interface TokenProviderDeps {
	sql: Sql;
	key: Buffer;
	credentials: (client: OAuthClient) => { clientId: string; clientSecret: string } | null;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export function createTokenProvider(deps: TokenProviderDeps) {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const memory = new Map<OAuthClient, { token: string; expiresAt: number }>();
	const forced = new Set<OAuthClient>();

	function fresh(expires: Date | number | null | undefined): boolean {
		if (!expires) return false;
		return new Date(expires).getTime() - now() > EARLY_REFRESH_MS;
	}

	function remember(client: OAuthClient, token: string, expires: Date | number): string {
		memory.set(client, { token, expiresAt: new Date(expires).getTime() });
		return token;
	}

	async function refreshLocked(
		client: OAuthClient,
		force: boolean
	): Promise<{ token?: string; expires?: Date; error?: ReauthRequired; locked?: boolean }> {
		return deps.sql.begin(async (tx) => {
			const rows = await tx<Row[]>`
				SELECT spotify_client_id, refresh_token_enc, access_token_enc, access_expires_at
				FROM hub_oauth_tokens WHERE client = ${client} FOR UPDATE SKIP LOCKED`;
			const row = rows[0];
			if (!row) return { locked: true };
			if (!force && row.access_token_enc && fresh(row.access_expires_at)) {
				// Another lambda refreshed while we waited for the lock.
				return { token: decrypt(row.access_token_enc, deps.key, aadFor(client, 'access_token')), expires: row.access_expires_at! };
			}
			const creds = deps.credentials(client);
			if (!creds || creds.clientId !== row.spotify_client_id) return { error: new ReauthRequired(client, 'client_mismatch') };
			const refreshToken = decrypt(row.refresh_token_enc, deps.key, aadFor(client, 'refresh_token'));
			let tok: TokenResponse;
			try {
				tok = await refreshAccessToken(refreshToken, creds, deps.fetch);
			} catch (e) {
				if (e instanceof InvalidGrant) {
					await tx`UPDATE hub_oauth_tokens SET last_error = 'invalid_grant', last_error_at = now(), updated_at = now() WHERE client = ${client}`;
					return { error: new ReauthRequired(client, 'invalid_grant') };
				}
				throw e;
			}
			const expires = new Date(now() + tok.expires_in * 1000);
			const accessEnc = encrypt(tok.access_token, deps.key, aadFor(client, 'access_token'));
			if (tok.refresh_token && tok.refresh_token !== refreshToken) {
				const refreshEnc = encrypt(tok.refresh_token, deps.key, aadFor(client, 'refresh_token'));
				await tx`
					UPDATE hub_oauth_tokens SET access_token_enc = ${accessEnc}, access_expires_at = ${expires},
						refresh_token_enc = ${refreshEnc}, last_refresh_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now()
					WHERE client = ${client}`;
			} else {
				await tx`
					UPDATE hub_oauth_tokens SET access_token_enc = ${accessEnc}, access_expires_at = ${expires},
						last_refresh_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now()
					WHERE client = ${client}`;
			}
			return { token: tok.access_token, expires };
		});
	}

	async function getAccessToken(client: OAuthClient = 'hub'): Promise<string> {
		const force = forced.has(client);
		const m = memory.get(client);
		if (!force && m && fresh(m.expiresAt)) return m.token;

		for (let attempt = 0; attempt < 5; attempt++) {
			if (force) {
				const r = await refreshLocked(client, true);
				if (r.error) throw r.error;
				if (r.token && r.expires) {
					forced.delete(client);
					return remember(client, r.token, r.expires);
				}
				await sleep(250 * (attempt + 1));
				continue;
			}
			const rows = await deps.sql<{ access_token_enc: Uint8Array | null; access_expires_at: Date | null }[]>`
				SELECT access_token_enc, access_expires_at FROM hub_oauth_tokens WHERE client = ${client}`;
			const row = rows[0];
			if (!row) throw new ReauthRequired(client, 'missing');
			if (row.access_token_enc && fresh(row.access_expires_at)) {
				return remember(client, decrypt(row.access_token_enc, deps.key, aadFor(client, 'access_token')), row.access_expires_at!);
			}
			const r = await refreshLocked(client, false);
			if (r.error) throw r.error;
			if (r.token && r.expires) return remember(client, r.token, r.expires);
			await sleep(250 * (attempt + 1)); // locked by a parallel refresh
		}
		throw new ReauthRequired(client, 'busy');
	}

	/** After a 401: the cached token was revoked early. The next call refreshes. */
	function invalidate(client: OAuthClient = 'hub'): void {
		memory.delete(client);
		forced.add(client);
	}

	/** Drop this lambda's cached token (e.g. after a new authorization), without forcing a refresh. */
	function forget(client: OAuthClient = 'hub'): void {
		memory.delete(client);
		forced.delete(client);
	}

	return { getAccessToken, invalidate, forget };
}

export type TokenProvider = ReturnType<typeof createTokenProvider>;
