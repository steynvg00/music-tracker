/**
 * R2 write paths through the guard: custom playlist create / edit / delete, kind-pinned
 * writes, the unfollow fallback, and the bypass scan covering the new modules.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpotifyApi } from './api';
import { ReadOnlyPlaylist, createWriteGuard } from './write-guard';
import { createCustom, deleteCustom, updateCustom } from '$lib/server/custom';
import { DEFAULT_FILTERS } from '$lib/shared/custom';
import { fakeFetch, fakeSql, type RecordedRequest } from '$lib/server/test-helpers';

const OWNER = 'owner-id';
const ID = '37i9dQZF1DXcBWIGoYBM5M';
const NEW_ID = 'NEWCUSTOMPLAYLIST00000';
const T = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;

function spotifyWith(names: Record<string, { name: string; owner?: string }>, opts: { libraryDelete?: number } = {}) {
	const ff = fakeFetch((req) => {
		const m = /^\/v1\/playlists\/([A-Za-z0-9]{22})$/.exec(req.url.pathname);
		if (req.method === 'GET' && m) {
			const p = names[m[1]!];
			return p ? { status: 200, body: { id: m[1], name: p.name, owner: { id: p.owner ?? OWNER }, snapshot_id: 's' } } : { status: 404, body: {} };
		}
		if (req.method === 'POST' && req.url.pathname === '/v1/me/playlists') {
			const name = (req.body as { name: string }).name;
			names[NEW_ID] = { name };
			return { status: 201, body: { id: NEW_ID, name } };
		}
		if (req.method === 'DELETE' && req.url.pathname === '/v1/me/library') {
			const status = opts.libraryDelete ?? 200;
			return status === 200 ? { status: 200, body: {} } : { status, body: { error: { status, message: 'nope' } } };
		}
		if (req.method !== 'GET') return { status: 200, body: { snapshot_id: 'next' } };
		return undefined;
	});
	const api = new SpotifyApi({ getToken: async () => 'tok', fetch: ff.fetch });
	return { guard: createWriteGuard(api, OWNER), calls: ff.calls };
}

const writes = (calls: RecordedRequest[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.pathname}`);

function previewSql(customRow?: { name: string }) {
	return fakeSql((q) => {
		if (q.text.startsWith('SELECT * FROM hub.custom_playlist_preview')) {
			return [1, 2, 3, 4].map((i) => ({ track_uri: T(i), track_name: `t${i}`, artist_name: 'a', album_name: null, plays: 5, first_played_at: null, release_year: null }));
		}
		if (q.text.startsWith('SELECT * FROM custom_playlists')) {
			return customRow ? [{ playlist_id: ID, name: customRow.name, created_at: new Date(), expires_at: null, track_count: 4, filters_summary: '', filters_json: null, excluded_uris: [] }] : [];
		}
		if (q.text.startsWith('SELECT now()')) return [{ now: new Date() }];
		return [];
	});
}

describe('kind-pinned writes', () => {
	it.each(['replaceItems', 'addItems', 'removeItems'] as const)('%s with requireKind custom refuses an Auto playlist', async (fn) => {
		const { guard, calls } = spotifyWith({ [ID]: { name: 'Top 30 last 30 days · Auto 🤖🔄' } });
		const call =
			fn === 'replaceItems'
				? guard.replaceItems(ID, [T(1)], { requireKind: 'custom' })
				: fn === 'addItems'
					? guard.addItems(ID, [T(1)], undefined, { requireKind: 'custom' })
					: guard.removeItems(ID, [T(1)], undefined, { requireKind: 'custom' });
		const err = await call.catch((e) => e);
		expect(err).toBeInstanceOf(ReadOnlyPlaylist);
		expect(err.reason).toBe('not_custom');
		expect(writes(calls)).toEqual([]);
	});

	it('a rename may not move a playlist into another managed kind', async () => {
		const { guard, calls } = spotifyWith({ [ID]: { name: 'Top 30 last 30 days · Auto 🤖🔄' } });
		const err = await guard.changeDetails(ID, { name: 'Mine · Custom 🎧' }).catch((e) => e);
		expect(err.reason).toBe('wrong_kind');
		expect(writes(calls)).toEqual([]);
	});
});

describe('unfollowCustom', () => {
	it('falls back to DELETE /playlists/{id}/followers when /me/library refuses', async () => {
		const { guard, calls } = spotifyWith({ [ID]: { name: 'Gym · Custom 🎧' } }, { libraryDelete: 404 });
		await guard.unfollowCustom(ID);
		expect(writes(calls)).toEqual([`DELETE /v1/me/library`, `DELETE /v1/playlists/${ID}/followers`]);
	});

	it('also falls back on 403 (a token minted before v0.82 has no user-library-modify)', async () => {
		const { guard, calls } = spotifyWith({ [ID]: { name: 'Gym · Custom 🎧' } }, { libraryDelete: 403 });
		await guard.unfollowCustom(ID);
		expect(writes(calls)).toEqual([`DELETE /v1/me/library`, `DELETE /v1/playlists/${ID}/followers`]);
	});

	it('never reaches either endpoint for a non-custom playlist', async () => {
		for (const name of ['Road trip', 'Top 30 last 30 days · Auto 🤖🔄', 'x · Custom 🎧 (copy)']) {
			const { guard, calls } = spotifyWith({ [ID]: { name } }, { libraryDelete: 404 });
			await expect(guard.unfollowCustom(ID)).rejects.toBeInstanceOf(ReadOnlyPlaylist);
			expect(writes(calls)).toEqual([]);
		}
	});
});

describe('custom playlists through the guard', () => {
	it('create = POST /me/playlists (custom suffix) + guarded add, minus excluded tracks', async () => {
		const sp = spotifyWith({});
		const db = previewSql();
		const r = await createCustom(
			{ sql: db.sql, guard: sp.guard, ownerId: OWNER },
			{ name: 'Smoke test', filters: DEFAULT_FILTERS, excluded: [T(2)], lifetime: '7d' }
		);
		expect(r).toMatchObject({ playlistId: NEW_ID, name: 'Smoke test · Custom 🎧', trackCount: 3 });
		expect(writes(sp.calls)).toEqual(['POST /v1/me/playlists', `POST /v1/playlists/${NEW_ID}/items`]);
		const created = sp.calls.find((c) => c.url.pathname === '/v1/me/playlists')!;
		expect(created.body).toMatchObject({ name: 'Smoke test · Custom 🎧', public: false });
		const added = sp.calls.find((c) => c.url.pathname.endsWith('/items'))!;
		expect((added.body as { uris: string[] }).uris).toEqual([T(1), T(3), T(4)]);
		// Guard read happened before the add.
		expect(sp.calls.findIndex((c) => c.method === 'GET' && c.url.pathname === `/v1/playlists/${NEW_ID}`)).toBeLessThan(
			sp.calls.findIndex((c) => c.url.pathname.endsWith('/items'))
		);
		const insert = db.queries.find((q) => q.text.startsWith('INSERT INTO custom_playlists'))!;
		expect(insert.values).toContain('Smoke test · Custom 🎧');
	});

	it('edit refuses when the DB says custom but Spotify has renamed it (live check wins)', async () => {
		const sp = spotifyWith({ [ID]: { name: 'Renamed in Spotify' } });
		const db = previewSql({ name: 'Gym · Custom 🎧' });
		await expect(updateCustom({ sql: db.sql, guard: sp.guard, ownerId: OWNER }, ID, { filters: DEFAULT_FILTERS, excluded: [] })).rejects.toBeInstanceOf(
			ReadOnlyPlaylist
		);
		expect(writes(sp.calls)).toEqual([]);
	});

	it('edit of a playlist with no custom row is refused before Spotify is called', async () => {
		const sp = spotifyWith({ [ID]: { name: 'Road trip' } });
		const db = previewSql();
		const err = await updateCustom({ sql: db.sql, guard: sp.guard, ownerId: OWNER }, ID, { filters: DEFAULT_FILTERS, excluded: [] }).catch((e) => e);
		expect(err.reason).toBe('not_custom');
		expect(sp.calls).toEqual([]);
	});

	it('edit replaces items with requireKind custom', async () => {
		const sp = spotifyWith({ [ID]: { name: 'Gym · Custom 🎧' } });
		const db = previewSql({ name: 'Gym · Custom 🎧' });
		const r = await updateCustom({ sql: db.sql, guard: sp.guard, ownerId: OWNER }, ID, { filters: DEFAULT_FILTERS, excluded: [T(1), T(2)] });
		expect(r.trackCount).toBe(2);
		expect(writes(sp.calls)).toEqual([`PUT /v1/playlists/${ID}/items`]);
	});

	it('delete of an unmanaged playlist writes nothing and keeps the DB untouched', async () => {
		const sp = spotifyWith({ [ID]: { name: 'Road trip' } });
		const db = previewSql();
		await expect(deleteCustom({ sql: db.sql, guard: sp.guard, ownerId: OWNER }, ID)).rejects.toBeInstanceOf(ReadOnlyPlaylist);
		expect(writes(sp.calls)).toEqual([]);
		expect(db.queries.some((q) => q.text.startsWith('DELETE FROM custom_playlists'))).toBe(false);
	});
});

describe('bypass scan covers R2 modules', () => {
	it('no new module writes to Spotify outside the guard', () => {
		const root = fileURLToPath(new URL('../../../', import.meta.url));
		const scanned: string[] = [];
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
					const rel = relative(root, p).replaceAll('\\', '/');
					scanned.push(rel);
					const text = readFileSync(p, 'utf8');
					if (rel !== 'lib/server/spotify/write-guard.ts' && rel !== 'lib/server/spotify/api.ts' && text.includes('_sendPlaylistWrite')) offenders.push(rel);
					// No raw fetch to the Spotify Web API outside api.ts / oauth.ts.
					if (!['lib/server/spotify/api.ts', 'lib/server/spotify/oauth.ts'].includes(rel) && /fetch\([^)]*api\.spotify\.com/.test(text)) offenders.push(rel);
				}
			}
		};
		walk(root);
		for (const f of ['lib/server/custom.ts', 'lib/server/library.ts', 'lib/server/jobs.ts', 'lib/server/push.ts']) expect(scanned).toContain(f);
		expect(offenders).toEqual([]);
	});
});
