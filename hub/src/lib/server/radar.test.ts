/**
 * R7 Release radar: status/date helpers, the guarded "New from your artists · Auto 🤖🔄" write,
 * "Follow in Rotor" validation, and the bypass scan over every new R7 module.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpotifyApi } from './spotify/api';
import { ReadOnlyPlaylist, createWriteGuard } from './spotify/write-guard';
import { fakeFetch, fakeSql } from './test-helpers';
import { comingUp, follow, playlistUris, unfollow, updatePlaylist } from './radar';
import { RADAR_PLAYLIST_NAME, isRadarPlaylistName, radarDate, radarStatus } from '$lib/shared/radar';
import { BadInput } from '$lib/shared/custom';

const OWNER = 'owner-id';
const PL = 'RADARPLAYLIST000000001';
const T = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;

describe('radar helpers', () => {
	it('status: in your library wins, then announced (future) vs out', () => {
		expect(radarStatus('2026-11-20', false, '2026-11-07')).toBe('announced');
		expect(radarStatus('2026-11-07', false, '2026-11-07')).toBe('out');
		expect(radarStatus('2026-10-01', false, '2026-11-07')).toBe('out');
		expect(radarStatus('2026-11-20', true, '2026-11-07')).toBe('in_library');
		expect(radarStatus(null, false, '2026-11-07')).toBe('out');
	});
	it('dates by precision', () => {
		expect(radarDate('2026-03-06', 'day')).toBe('6 Mar 2026');
		expect(radarDate('2026-03-01', 'month')).toBe('March 2026');
		expect(radarDate('2026-01-01', 'year')).toBe('2026');
		expect(radarDate(null, null)).toBe('Date to be announced');
	});
	it('the radar playlist name and its look-alikes', () => {
		expect(RADAR_PLAYLIST_NAME).toBe('New from your artists · Auto 🤖🔄');
		expect(isRadarPlaylistName('New from your artists · Auto 🤖🔄')).toBe(true);
		for (const n of ['New from your artists · Auto 🤖📸', 'New from your artists · Custom 🎧', 'New from your artists', 'New from your artists · Auto 🤖🔄 ']) {
			expect(isRadarPlaylistName(n), n).toBe(false);
		}
	});
});

describe('radar server', () => {
	it('playlist URIs: last 14 days of Spotify releases, valid track URIs only, de-duplicated', async () => {
		const { sql, queries } = fakeSql((q) => (q.text.includes('cardinality(track_uris) > 0') ? [{ track_uris: [T(1), T(2)] }, { track_uris: [T(2), 'spotify:episode:000000000000000000000x', T(3)] }] : []));
		expect(await playlistUris(sql, '2026-11-07')).toEqual([T(1), T(2), T(3)]);
		expect(queries[0]!.values).toContain(14);
	});

	function setup(liveName: string, mirrored: boolean, uris = [T(1), T(2)]) {
		const ff = fakeFetch((req) => {
			const p = req.url.pathname;
			if (req.method === 'GET' && p === '/v1/me/playlists') return { status: 200, body: { items: [], next: null } };
			if (req.method === 'POST' && p === '/v1/me/playlists') return { status: 201, body: { id: PL, name: (req.body as { name: string }).name } };
			if (req.method === 'GET' && p === `/v1/playlists/${PL}`) return { status: 200, body: { id: PL, name: liveName, owner: { id: OWNER }, snapshot_id: 's' } };
			if (p === `/v1/playlists/${PL}/items`) return { status: 200, body: { snapshot_id: 'n' } };
			return undefined;
		});
		const { sql } = fakeSql((q) => {
			if (q.text.includes('cardinality(track_uris) > 0')) return uris.length ? [{ track_uris: uris }] : [];
			if (q.text.includes('FROM spotify_playlists WHERE name =')) return mirrored ? [{ playlist_id: PL }] : [];
			if (q.text.startsWith('SELECT now()')) return [{ now: new Date() }];
			return [];
		});
		const api = new SpotifyApi({ getToken: async () => 'tok', fetch: ff.fetch });
		return { deps: { sql, api, guard: createWriteGuard(api, OWNER), ownerId: OWNER }, calls: ff.calls };
	}

	it('Update playlist: creates "New from your artists · Auto 🤖🔄" and replaces its items through the guard', async () => {
		const { deps, calls } = setup(RADAR_PLAYLIST_NAME, false);
		const r = await updatePlaylist(deps, '2026-11-07');
		expect(r).toEqual({ playlistId: PL, name: RADAR_PLAYLIST_NAME, trackCount: 2, created: true });
		expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['POST /v1/me/playlists', `PUT /v1/playlists/${PL}/items`]);
		expect((calls.find((c) => c.method === 'POST')!.body as { name: string }).name).toBe(RADAR_PLAYLIST_NAME);
	});

	it('refuses when Spotify says it is not an Auto 🔄 playlist: nothing written', async () => {
		for (const live of ['New from your artists', 'New from your artists · Auto 🤖📸', 'New from your artists · Custom 🎧']) {
			const { deps, calls } = setup(live, true);
			await expect(updatePlaylist(deps, '2026-11-07')).rejects.toBeInstanceOf(ReadOnlyPlaylist);
			expect(calls.filter((c) => c.method !== 'GET'), live).toEqual([]);
		}
	});

	it('no recent Spotify releases → nothing written', async () => {
		const { deps, calls } = setup(RADAR_PLAYLIST_NAME, true, []);
		await expect(updatePlaylist(deps, '2026-11-07')).rejects.toBeInstanceOf(BadInput);
		expect(calls).toEqual([]);
	});

	it('follow / unfollow only take a Spotify artist id and a name', async () => {
		const { sql, queries } = fakeSql(() => []);
		await follow(sql, '0aJcPBUeTwNR5HJX0e6R0V', '  Headhunterz  ');
		expect(queries[0]!.values).toEqual(['0aJcPBUeTwNR5HJX0e6R0V', 'Headhunterz']);
		await expect(follow(sql, 'not-an-id', 'X')).rejects.toBeInstanceOf(BadInput);
		await expect(follow(sql, '0aJcPBUeTwNR5HJX0e6R0V', '   ')).rejects.toBeInstanceOf(BadInput);
		await expect(unfollow(sql, "x' OR 1=1")).rejects.toBeInstanceOf(BadInput);
	});

	it('Home "Coming up" is empty before migration 0028', async () => {
		// Every tagged-template call (the query AND its nested sql`…` fragments) rejects like a
		// missing table. The fragments are never awaited, so mark each rejection handled up front;
		// awaiting the query still rejects (CI's vitest failed on the 2 unhandled rejections).
		const sql = (() => {
			const f = () => {
				const p = Promise.reject(Object.assign(new Error('relation "radar_releases" does not exist'), { code: '42P01' }));
				p.catch(() => undefined);
				return p;
			};
			return f as unknown as Parameters<typeof comingUp>[0];
		})();
		expect(await comingUp(sql, '2026-11-07')).toEqual([]);
	});
});

describe('bypass scan covers R7 modules', () => {
	it('no R7 module touches the Spotify write path directly', () => {
		const root = fileURLToPath(new URL('../../', import.meta.url));
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
					if (/musicbrainz\.org|scantraxx\.com/.test(text) && rel.startsWith('lib/server')) offenders.push(`${rel} (radar sources are Python-only)`);
				}
			}
		};
		walk(root);
		for (const f of [
			'lib/server/radar.ts',
			'lib/shared/radar.ts',
			'routes/api/radar/+server.ts',
			'routes/api/radar/follow/[id]/+server.ts',
			'routes/api/radar/playlist/+server.ts',
			'routes/(app)/radar/+page.svelte',
			'routes/(app)/artist/[id]/+page.svelte'
		]) {
			expect(scanned).toContain(f);
		}
		expect(offenders).toEqual([]);
	});
});
