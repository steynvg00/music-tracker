/**
 * R3 write path: "Save as custom playlist" from Stats lists goes through the guard
 * (create with the Custom suffix, guarded add with requireKind custom), and the bypass scan
 * covers every new R3 module.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpotifyApi } from './api';
import { ReadOnlyPlaylist, createWriteGuard } from './write-guard';
import { createCustomFromTracks } from '$lib/server/custom';
import { fakeFetch, fakeSql } from '$lib/server/test-helpers';
import { BadInput } from '$lib/shared/custom';

const OWNER = 'owner-id';
const NEW_ID = 'NEWCUSTOMPLAYLIST00000';
const T = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;

function setup(createdName?: string) {
	const ff = fakeFetch((req) => {
		if (req.method === 'POST' && req.url.pathname === '/v1/me/playlists') return { status: 201, body: { id: NEW_ID, name: (req.body as { name: string }).name } };
		if (req.method === 'GET' && req.url.pathname === `/v1/playlists/${NEW_ID}`) {
			return { status: 200, body: { id: NEW_ID, name: createdName ?? 'Top 2024 · Custom 🎧', owner: { id: OWNER }, snapshot_id: 's' } };
		}
		if (req.method === 'POST' && req.url.pathname === `/v1/playlists/${NEW_ID}/items`) return { status: 201, body: { snapshot_id: 'n' } };
		return undefined;
	});
	const { sql, queries } = fakeSql((q) => (q.text.startsWith('SELECT now()') ? [{ now: new Date() }] : []));
	const guard = createWriteGuard(new SpotifyApi({ getToken: async () => 'tok', fetch: ff.fetch }), OWNER);
	return { deps: { sql, guard, ownerId: OWNER }, calls: ff.calls, queries };
}

describe('createCustomFromTracks', () => {
	it('creates "<name> · Custom 🎧", then a guarded add of only valid, de-duplicated track URIs', async () => {
		const { deps, calls, queries } = setup();
		const r = await createCustomFromTracks(deps, {
			name: 'Top 2024',
			uris: [T(1), T(2), T(1), 'spotify:episode:0000000000000000000003', 'not-a-uri'],
			lifetime: '7d',
			source: 'Stats › Top tracks · 2024'
		});
		expect(r).toMatchObject({ playlistId: NEW_ID, name: 'Top 2024 · Custom 🎧', trackCount: 2 });
		const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.pathname}`);
		expect(writes).toEqual(['POST /v1/me/playlists', `POST /v1/playlists/${NEW_ID}/items`]);
		// The guard re-reads the new playlist live before adding.
		expect(calls.some((c) => c.method === 'GET' && c.url.pathname === `/v1/playlists/${NEW_ID}`)).toBe(true);
		const add = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/items'));
		expect((add?.body as { uris: string[] }).uris).toEqual([T(1), T(2)]);
		expect(queries.some((q) => q.text.startsWith('INSERT INTO custom_playlists'))).toBe(true);
	});

	it('refuses to add when Spotify says the new playlist is not Custom (live check wins)', async () => {
		const { deps, calls } = setup('Top 2024 · Auto 🤖🔄');
		await expect(createCustomFromTracks(deps, { name: 'Top 2024', uris: [T(1)], lifetime: 'keep', source: 's' })).rejects.toBeInstanceOf(ReadOnlyPlaylist);
		expect(calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/items'))).toHaveLength(0);
	});

	it('an empty or unplayable list writes nothing', async () => {
		const { deps, calls } = setup();
		await expect(createCustomFromTracks(deps, { name: 'x', uris: ['spotify:episode:0000000000000000000003'], lifetime: '7d', source: 's' })).rejects.toBeInstanceOf(BadInput);
		expect(calls).toHaveLength(0);
	});
});

describe('bypass scan covers R3 modules', () => {
	it('stats, detail and search modules never touch the Spotify write path', () => {
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
					if (!['lib/server/spotify/api.ts', 'lib/server/spotify/oauth.ts'].includes(rel) && /api\.spotify\.com/.test(text)) offenders.push(rel);
				}
			}
		};
		walk(root);
		for (const f of [
			'lib/server/stats/core.ts',
			'lib/server/stats/sections.ts',
			'lib/server/stats/detail.ts',
			'lib/server/stats/http.ts',
			'routes/api/custom/from-tracks/+server.ts',
			'routes/api/stats/[section]/+server.ts',
			'routes/api/track/[uri]/+server.ts',
			'routes/api/search/+server.ts'
		]) {
			expect(scanned).toContain(f);
		}
		expect(offenders).toEqual([]);
	});
});
