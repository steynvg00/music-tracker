import { describe, expect, it } from 'vitest';
import { aadFor, decrypt, encrypt } from '$lib/server/crypto';
import { createTokenProvider, daysLeft, expiresAt, ReauthRequired, tokenHealth } from './token';
import { fakeFetch, fakeSql } from '$lib/server/test-helpers';

const key = Buffer.alloc(32, 7);
const NOW = Date.parse('2026-11-04T10:00:00Z');

describe('6-month clock', () => {
	it('adds calendar months and clamps the day', () => {
		expect(expiresAt(new Date('2026-11-03T12:00:00Z')).toISOString()).toBe('2027-05-03T12:00:00.000Z');
		expect(expiresAt(new Date('2026-08-31T00:00:00Z')).toISOString()).toBe('2027-02-28T00:00:00.000Z');
	});
	it('counts days left and colours the countdown (amber ≤ 21, red ≤ 7 or invalid_grant)', () => {
		expect(daysLeft(new Date('2026-05-21T00:00:00Z'), new Date('2026-11-04T00:00:00Z'))).toBe(17);
		expect(tokenHealth(60, null)).toBe('ok');
		expect(tokenHealth(21, null)).toBe('warn');
		expect(tokenHealth(7, null)).toBe('danger');
		expect(tokenHealth(90, 'invalid_grant')).toBe('danger');
	});
});

interface Row {
	spotify_client_id: string;
	refresh_token_enc: Buffer;
	access_token_enc: Buffer | null;
	access_expires_at: Date | null;
	last_error: string | null;
	authorized_at: Date;
}

function world(row: Row | null, tokenRoute: Parameters<typeof fakeFetch>[0]) {
	const state = { row };
	const { sql, queries } = fakeSql((q) => {
		if (q.text.startsWith('SELECT access_token_enc, access_expires_at FROM hub_oauth_tokens')) return state.row ? [state.row] : [];
		if (q.text.includes('FOR UPDATE SKIP LOCKED')) return state.row ? [state.row] : [];
		if (q.text.startsWith('UPDATE hub_oauth_tokens SET last_error')) {
			state.row!.last_error = 'invalid_grant';
			return [];
		}
		if (q.text.startsWith('UPDATE hub_oauth_tokens SET access_token_enc')) {
			state.row!.access_token_enc = q.values[0] as Buffer;
			state.row!.access_expires_at = q.values[1] as Date;
			if (q.text.includes('refresh_token_enc')) state.row!.refresh_token_enc = q.values[2] as Buffer;
			return [];
		}
		return [];
	});
	const ff = fakeFetch(tokenRoute);
	const provider = createTokenProvider({
		sql,
		key,
		credentials: () => ({ clientId: 'hub-app', clientSecret: 's' }),
		fetch: ff.fetch,
		now: () => NOW,
		sleep: async () => {}
	});
	return { provider, state, queries, calls: ff.calls };
}

const baseRow = (over: Partial<Row> = {}): Row => ({
	spotify_client_id: 'hub-app',
	refresh_token_enc: encrypt('refresh-1', key, aadFor('hub', 'refresh_token')),
	access_token_enc: null,
	access_expires_at: null,
	last_error: null,
	authorized_at: new Date('2026-11-03T00:00:00Z'),
	...over
});

describe('createTokenProvider', () => {
	it('uses a still-fresh cached access token without calling Spotify', async () => {
		const w = world(baseRow({ access_token_enc: encrypt('cached', key, aadFor('hub', 'access_token')), access_expires_at: new Date(NOW + 30 * 60_000) }), () => undefined);
		expect(await w.provider.getAccessToken('hub')).toBe('cached');
		expect(w.calls).toHaveLength(0);
	});

	it('refreshes an expiring token under the row lock and caches it', async () => {
		const w = world(baseRow({ access_token_enc: encrypt('old', key, aadFor('hub', 'access_token')), access_expires_at: new Date(NOW + 60_000) }), () => ({
			status: 200,
			body: { access_token: 'new', token_type: 'Bearer', expires_in: 3600 }
		}));
		expect(await w.provider.getAccessToken('hub')).toBe('new');
		expect(w.queries.some((q) => q.text.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
		expect(decrypt(w.state.row!.access_token_enc!, key, aadFor('hub', 'access_token'))).toBe('new');
		expect(await w.provider.getAccessToken('hub')).toBe('new');
		expect(w.calls).toHaveLength(1);
	});

	it('stores a rotated refresh token but never touches authorized_at', async () => {
		const w = world(baseRow(), () => ({ status: 200, body: { access_token: 'a2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2' } }));
		await w.provider.getAccessToken('hub');
		expect(decrypt(w.state.row!.refresh_token_enc, key, aadFor('hub', 'refresh_token'))).toBe('refresh-2');
		expect(w.queries.every((q) => !/authorized_at/.test(q.text))).toBe(true);
	});

	it('invalid_grant → last_error written + ReauthRequired', async () => {
		const w = world(baseRow(), () => ({ status: 400, body: { error: 'invalid_grant' } }));
		const err = await w.provider.getAccessToken('hub').catch((e) => e);
		expect(err).toBeInstanceOf(ReauthRequired);
		expect(err.detail).toBe('invalid_grant');
		expect(w.state.row!.last_error).toBe('invalid_grant');
	});

	it('no row → ReauthRequired(missing)', async () => {
		const w = world(null, () => undefined);
		await expect(w.provider.getAccessToken('hub')).rejects.toMatchObject({ detail: 'missing' });
	});

	it('a row minted by another Spotify app → ReauthRequired(client_mismatch)', async () => {
		const w = world(baseRow({ spotify_client_id: 'cron-app' }), () => undefined);
		await expect(w.provider.getAccessToken('hub')).rejects.toMatchObject({ detail: 'client_mismatch' });
		expect(w.calls).toHaveLength(0);
	});

	it('invalidate() after a 401 forces a real refresh even with a fresh DB token', async () => {
		const w = world(baseRow({ access_token_enc: encrypt('revoked', key, aadFor('hub', 'access_token')), access_expires_at: new Date(NOW + 30 * 60_000) }), () => ({
			status: 200,
			body: { access_token: 'replacement', token_type: 'Bearer', expires_in: 3600 }
		}));
		expect(await w.provider.getAccessToken('hub')).toBe('revoked');
		w.provider.invalidate('hub');
		expect(await w.provider.getAccessToken('hub')).toBe('replacement');
	});
});
