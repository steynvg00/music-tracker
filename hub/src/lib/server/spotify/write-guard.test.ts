import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuardBypassError, SpotifyApi, isPlaylistWrite } from './api';
import { ReadOnlyPlaylist, createWriteGuard } from './write-guard';
import { managedKind } from '$lib/shared/managed';
import { fakeFetch, type RecordedRequest } from '$lib/server/test-helpers';

const OWNER = 'owner-id';
const ID = '37i9dQZF1DXcBWIGoYBM5M'; // 22 chars
const T = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;

const fixture = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../../../tests/fixtures/managed_names.json', import.meta.url)), 'utf8')
) as { cases: { name: string; kind: string | null }[] };

function setup(playlist: { name: string; owner: string } | null) {
	const ff = fakeFetch((req) => {
		if (req.method === 'GET' && req.url.pathname === `/v1/playlists/${ID}`) {
			return playlist ? { status: 200, body: { id: ID, name: playlist.name, owner: { id: playlist.owner }, snapshot_id: 'snap' } } : { status: 404, body: { error: { status: 404, message: 'Not found' } } };
		}
		if (req.method === 'POST' && req.url.pathname === '/v1/me/playlists') {
			return { status: 201, body: { id: 'NEWPLAYLISTID000000000', name: (req.body as { name: string }).name } };
		}
		if (req.method !== 'GET') return { status: 201, body: { snapshot_id: 'next' } };
		return undefined;
	});
	const api = new SpotifyApi({ getToken: async () => 'tok', fetch: ff.fetch });
	return { guard: createWriteGuard(api, OWNER), calls: ff.calls, api };
}

const writes = (calls: RecordedRequest[]) => calls.filter((c) => c.method !== 'GET');

describe('managedKind (shared fixture with the Python mirror)', () => {
	for (const c of fixture.cases) {
		it(`${JSON.stringify(c.name)} → ${c.kind}`, () => expect(managedKind(c.name)).toBe(c.kind));
	}
});

describe('assertWritable', () => {
	it('accepts an owned playlist with a managed suffix', async () => {
		const { guard } = setup({ name: 'Daily pick · Auto 🤖🔄', owner: OWNER });
		await expect(guard.assertWritable(ID)).resolves.toMatchObject({ kind: 'auto_updating', snapshotId: 'snap' });
	});

	it('checks live at Spotify with a narrow fields filter', async () => {
		const { guard, calls } = setup({ name: 'Daily pick · Auto 🤖🔄', owner: OWNER });
		await guard.assertWritable(ID);
		expect(calls[0]!.url.searchParams.get('fields')).toBe('id,name,owner(id),snapshot_id');
	});

	it.each([
		['unmanaged', { name: 'Road trip Italy 2022', owner: OWNER }, 'no_managed_suffix'],
		['not owned, managed-looking name', { name: 'Gym · Custom 🎧', owner: 'someone-else' }, 'not_owned'],
		['suffix-spoofed copy', { name: 'x · Custom 🎧 (copy)', owner: OWNER }, 'no_managed_suffix'],
		['trailing space', { name: 'x · Auto 🤖🔄 ', owner: OWNER }, 'no_managed_suffix'],
		['lookalike dot', { name: 'x ∙ Custom 🎧', owner: OWNER }, 'no_managed_suffix'],
		['zero-width tail', { name: 'x · Auto 🤖📸​', owner: OWNER }, 'no_managed_suffix'],
		['suffix only', { name: ' · Custom 🎧', owner: OWNER }, 'no_managed_suffix'],
		['Spotify-owned', { name: 'Discover Weekly', owner: 'spotify' }, 'not_owned']
	] as const)('rejects %s', async (_label, pl, reason) => {
		const { guard, calls } = setup(pl);
		const err = await guard.assertWritable(ID).catch((e) => e);
		expect(err).toBeInstanceOf(ReadOnlyPlaylist);
		expect(err.reason).toBe(reason);
		expect(writes(calls)).toHaveLength(0);
	});

	it('rejects malformed ids without calling Spotify', async () => {
		const { guard, calls } = setup({ name: 'x · Auto 🤖🔄', owner: OWNER });
		const err = await guard.assertWritable('../me/player').catch((e) => e);
		expect(err).toBeInstanceOf(ReadOnlyPlaylist);
		expect(err.reason).toBe('invalid_id');
		expect(calls).toHaveLength(0);
	});

	it('a 404 from Spotify propagates and nothing is written', async () => {
		const { guard, calls } = setup(null);
		await expect(guard.replaceItems(ID, [T(1)])).rejects.toMatchObject({ status: 404 });
		expect(writes(calls)).toHaveLength(0);
	});
});

describe('writers', () => {
	const readOnly = [
		{ name: 'Road trip Italy 2022', owner: OWNER },
		{ name: 'x · Custom 🎧 (copy)', owner: OWNER },
		{ name: 'Top 30 last 30 days · Auto 🤖🔄', owner: 'someone-else' }
	];

	it.each(readOnly)('every writer refuses %o before writing', async (pl) => {
		const { guard, calls } = setup(pl);
		const attempts = [
			guard.replaceItems(ID, [T(1)]),
			guard.addItems(ID, [T(1)]),
			guard.removeItems(ID, [T(1)]),
			guard.changeDetails(ID, { description: 'x' }),
			guard.unfollowCustom(ID)
		];
		for (const p of attempts) await expect(p).rejects.toBeInstanceOf(ReadOnlyPlaylist);
		expect(writes(calls)).toHaveLength(0);
	});

	it('replaceItems: PUT the first 100, POST the rest in batches of 100', async () => {
		const { guard, calls } = setup({ name: 'Daily pick · Auto 🤖🔄', owner: OWNER });
		const uris = Array.from({ length: 230 }, (_, i) => T(i));
		await guard.replaceItems(ID, uris);
		const w = writes(calls);
		expect(w.map((c) => c.method)).toEqual(['PUT', 'POST', 'POST']);
		expect(w.map((c) => (c.body as { uris: string[] }).uris.length)).toEqual([100, 100, 30]);
		expect(w.every((c) => c.url.pathname === `/v1/playlists/${ID}/items`)).toBe(true);
	});

	it('replaceItems with an empty list clears the playlist', async () => {
		const { guard, calls } = setup({ name: 'Daily pick · Auto 🤖🔄', owner: OWNER });
		await guard.replaceItems(ID, []);
		expect(writes(calls).map((c) => c.body)).toEqual([{ uris: [] }]);
	});

	it('rejects non-track URIs', async () => {
		const { guard, calls } = setup({ name: 'Daily pick · Auto 🤖🔄', owner: OWNER });
		await expect(guard.replaceItems(ID, ['spotify:playlist:' + ID])).rejects.toThrow(/Not a track/);
		expect(calls).toHaveLength(0);
	});

	it('removeItems uses the Feb 2026 { items: [{ uri }] } body', async () => {
		const { guard, calls } = setup({ name: 'Gym · Custom 🎧', owner: OWNER });
		await guard.removeItems(ID, [T(1)], 'snap');
		expect(writes(calls)[0]).toMatchObject({ method: 'DELETE', body: { items: [{ uri: T(1) }], snapshot_id: 'snap' } });
	});

	it('changeDetails refuses a rename that drops the managed suffix', async () => {
		const { guard, calls } = setup({ name: 'Gym · Custom 🎧', owner: OWNER });
		const err = await guard.changeDetails(ID, { name: 'Gym' }).catch((e) => e);
		expect(err).toBeInstanceOf(ReadOnlyPlaylist);
		expect(err.reason).toBe('name_not_managed');
		expect(calls).toHaveLength(0);
		await guard.changeDetails(ID, { name: 'Gym 2 · Custom 🎧' });
		expect(writes(calls)).toHaveLength(1);
	});

	it('unfollowCustom only removes Custom 🎧 playlists', async () => {
		const auto = setup({ name: 'Daily pick · Auto 🤖🔄', owner: OWNER });
		const err = await auto.guard.unfollowCustom(ID).catch((e) => e);
		expect(err).toBeInstanceOf(ReadOnlyPlaylist);
		expect(err.reason).toBe('not_custom');
		expect(writes(auto.calls)).toHaveLength(0);

		const custom = setup({ name: 'Late night · Custom 🎧', owner: OWNER });
		await custom.guard.unfollowCustom(ID);
		const [w] = writes(custom.calls);
		expect(w).toMatchObject({ method: 'DELETE' });
		expect(w!.url.pathname).toBe('/v1/me/library');
		expect(w!.url.searchParams.get('uris')).toBe(`spotify:playlist:${ID}`);
	});

	it('createManagedPlaylist requires a managed suffix and uses POST /me/playlists', async () => {
		const { guard, calls } = setup(null);
		await expect(guard.createManagedPlaylist({ name: 'Daily pick' })).rejects.toBeInstanceOf(ReadOnlyPlaylist);
		expect(calls).toHaveLength(0);
		const made = await guard.createManagedPlaylist({ name: 'Daily pick · Auto 🤖🔄' });
		expect(made.kind).toBe('auto_updating');
		expect(calls[0]).toMatchObject({ method: 'POST', body: { name: 'Daily pick · Auto 🤖🔄', public: false } });
	});
});

describe('no bypass', () => {
	it('SpotifyApi.request refuses every playlist write path', async () => {
		const { api, calls } = setup({ name: 'x · Auto 🤖🔄', owner: OWNER });
		const paths = [`/playlists/${ID}/items`, `/playlists/${ID}`, `/playlists/${ID}/followers`, '/me/playlists', '/users/me/playlists', '/me/library'];
		for (const p of paths) {
			for (const m of ['PUT', 'POST', 'DELETE'] as const) {
				expect(() => api.request(m, p)).toThrow(GuardBypassError);
			}
		}
		expect(calls).toHaveLength(0);
		expect(isPlaylistWrite('GET', `/playlists/${ID}/items`)).toBe(false);
		expect(isPlaylistWrite('PUT', '/me/player/play')).toBe(false);
	});

	it('only write-guard.ts (and api.ts) reference _sendPlaylistWrite', () => {
		const root = fileURLToPath(new URL('../../../', import.meta.url)); // hub/src
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|js|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
					const rel = relative(root, p).replaceAll('\\', '/');
					if (rel === 'lib/server/spotify/write-guard.ts' || rel === 'lib/server/spotify/api.ts') continue;
					if (readFileSync(p, 'utf8').includes('_sendPlaylistWrite')) offenders.push(rel);
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
