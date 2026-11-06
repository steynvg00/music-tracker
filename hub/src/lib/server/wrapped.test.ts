/**
 * R6 Rotor Wrapped: date window, card list, SVG escaping, the "Play your top 100" write path
 * (guarded, only "Wrapped <year> · Auto 🤖📸"), and the bypass scan over every new R6 module.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpotifyApi } from './spotify/api';
import { ReadOnlyPlaylist, createWriteGuard } from './spotify/write-guard';
import { fakeFetch, fakeSql } from './test-helpers';
import { loadWrapped, playTop100, requestBuild } from './wrapped';
import { requestRebuild } from './library';
import {
	homeWrappedCard,
	hoursOf,
	isWrappedPlaylistName,
	isWrappedYear,
	topUris,
	wrappedCards,
	wrappedPlaylistName,
	wrappedYears,
	type WrappedPayload
} from '$lib/shared/wrapped';
import { CARD_H, CARD_W, clip, describeCard, esc, renderCard, wrap } from '$lib/wrapped/cards';
import { BadInput } from '$lib/shared/custom';

const OWNER = 'owner-id';
const T = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;
const PL = 'WRAPPEDPLAYLIST0000001';

function payload(over: Partial<WrappedPayload> = {}): WrappedPayload {
	return {
		version: 1,
		year: 2025,
		through: '2025-12-31',
		live: false,
		generatedAt: '2026-01-01T05:47:00Z',
		totals: { plays: 1200, ms: 4_000_000_00, days: 300, firstDay: '2025-01-01', lastDay: '2025-12-31', tracks: 800, artists: 150, noMsPlays: 40 },
		topTracks: Array.from({ length: 120 }, (_, i) => ({ rank: i + 1, track: `Track ${i + 1}`, artist: 'A', uri: T(i % 105), plays: 200 - i, ms: 3_600_000 })),
		topArtists: [{ rank: 1, artist: 'A', plays: 900, ms: 7_200_000, tracks: 40 }],
		discoveries: { artists: 0, tracks: 0, topArtists: [], topTracks: [] },
		comebacks: { artists: 1, tracks: 0, topArtists: [{ artist: 'Old', plays: 5, gapDays: 800 }], topTracks: [] },
		streak: { days: 12, from: '2025-03-01', to: '2025-03-12' },
		biggestDay: { day: '2025-06-15', plays: 80, ms: 14_400_000, top: { track: 'T', artist: 'A', uri: T(1), plays: 9 } },
		clock: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 5 && h === 22 ? 50 : 1))),
		months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, plays: i === 5 ? 300 : 50, ms: 1000 })),
		badges: { count: 0, byType: {}, items: [] },
		previous: { year: 2024, plays: 1000, ms: 300_000_000, days: 280, artists: 140, tracks: 700, newArtists: 30, through: '2024-12-31' },
		...over
	};
}

describe('Wrapped dates and years', () => {
	it('Home card shows 1 Dec → 31 Jan only: December = so far, January = last year', () => {
		expect(homeWrappedCard('2026-11-30')).toBeNull();
		expect(homeWrappedCard('2026-12-01')).toEqual({ year: 2026, mode: 'so_far' });
		expect(homeWrappedCard('2026-12-31')).toEqual({ year: 2026, mode: 'so_far' });
		expect(homeWrappedCard('2027-01-01')).toEqual({ year: 2026, mode: 'frozen' });
		expect(homeWrappedCard('2027-01-31')).toEqual({ year: 2026, mode: 'frozen' });
		expect(homeWrappedCard('2027-02-01')).toBeNull();
	});
	it('years run from this year back to 2017', () => {
		const ys = wrappedYears('2026-11-06');
		expect(ys[0]).toBe(2026);
		expect(ys.at(-1)).toBe(2017);
		expect(ys).toHaveLength(10);
		expect(isWrappedYear('2016', '2026-11-06')).toBe(false);
		expect(isWrappedYear(2027, '2026-11-06')).toBe(false);
		expect(isWrappedYear('2020', '2026-11-06')).toBe(true);
	});
	it('playlist name and its look-alikes', () => {
		expect(wrappedPlaylistName(2025)).toBe('Wrapped 2025 · Auto 🤖📸');
		expect(isWrappedPlaylistName('Wrapped 2025 · Auto 🤖📸')).toBe(true);
		for (const n of ['Wrapped 2025 · Auto 🤖🔄', 'Wrapped 2025 · Custom 🎧', 'My Wrapped 2025 · Auto 🤖📸', 'Wrapped 2025 · Auto 🤖📸 ', 'Top 100 · 2025 · Auto 🤖📸']) {
			expect(isWrappedPlaylistName(n), n).toBe(false);
		}
	});
});

describe('cards', () => {
	it('every card with data, in order; an empty year is just intro + outro', () => {
		expect(wrappedCards(payload())).toEqual(['intro', 'totals', 'top_artists', 'top_tracks', 'comebacks', 'clock', 'streak', 'month', 'yoy', 'outro']);
		const empty = payload({
			totals: { plays: 0, ms: 0, days: 0, firstDay: null, lastDay: null, tracks: 0, artists: 0, noMsPlays: 0 },
			topTracks: [], topArtists: [], comebacks: { artists: 0, tracks: 0, topArtists: [], topTracks: [] }, streak: null, biggestDay: null,
			clock: Array.from({ length: 7 }, () => Array(24).fill(0)), months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, plays: 0, ms: 0 }))
		});
		expect(wrappedCards(empty)).toEqual(['intro', 'outro']);
		for (const k of wrappedCards(empty)) expect(renderCard(k, empty)).toContain('<svg');
	});

	it('top 100 URIs: valid track URIs only, de-duplicated, at most 100', () => {
		const p = payload();
		p.topTracks[3]!.uri = 'spotify:episode:0000000000000000000003';
		p.topTracks[4]!.uri = null;
		const u = topUris(p);
		expect(u).toHaveLength(100);
		expect(new Set(u).size).toBe(100);
		expect(u.every((x) => /^spotify:track:/.test(x))).toBe(true);
	});

	it('SVG cards escape every name, use no images or Spotify branding, and stay 1080×1920', () => {
		const evil = `<script>alert(1)</script> & "quotes" 'x' 🔥`;
		const p = payload({
			topTracks: [{ rank: 1, track: evil, artist: evil, uri: T(1), plays: 9, ms: 1 }],
			topArtists: [{ rank: 1, artist: evil, plays: 9, ms: 1, tracks: 1 }],
			badges: { count: 2, byType: { plays_50: 2 }, items: [] },
			discoveries: { artists: 1, tracks: 1, topArtists: [{ artist: evil, plays: 3, firstDay: '2025-02-02' }], topTracks: [] }
		});
		for (const k of wrappedCards(p)) {
			const svg = renderCard(k, p);
			expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), k).toBe(true);
			expect(svg).toContain(`viewBox="0 0 ${CARD_W} ${CARD_H}"`);
			expect(svg).not.toContain('<script');
			expect(svg).not.toMatch(/<image|href=|spotify/i);
			expect(svg).toContain('Rotor Wrapped 2025');
			expect(describeCard(k, p).length).toBeGreaterThan(3);
		}
		expect(renderCard('top_tracks', p)).toContain('&lt;script&gt;');
		expect(esc(`a<b>&"'`)).toBe('a&lt;b&gt;&amp;&quot;&#39;');
		expect(clip('🔥🔥🔥🔥', 3)).toBe('🔥🔥…');
		expect(wrap('Anthem of the Neverending Summer (Extended Mix)', 19)).toEqual(['Anthem of the', 'Neverending Summer…']);
		expect(wrap('Short', 19)).toEqual(['Short']);
		expect(wrap('Supercalifragilisticexpialidocious', 10)).toEqual(['Supercali…']);
	});

	it('"≈" marks hours when API plays without ms_played are in the year', () => {
		expect(renderCard('totals', payload())).toContain('≈ ');
		expect(renderCard('totals', payload({ totals: { ...payload().totals, noMsPlays: 0 } }))).not.toContain('≈');
		expect(hoursOf(5_400_000)).toBe('1.5');
		expect(hoursOf(3_600_000 * 1234)).toBe('1,234');
	});

	it('a live year says "so far, through <date>"', () => {
		expect(renderCard('intro', payload({ live: true, through: '2026-11-06' }))).toContain('so far, through 6 November');
	});
});

describe('server', () => {
	it('loadWrapped: this year is live, past years only from the frozen snapshot', async () => {
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('hub.wrapped_payload')) return [{ p: payload({ year: 2026, live: true }) }];
			if (q.text.includes('FROM wrapped_snapshots')) return [];
			return [];
		});
		expect((await loadWrapped(sql, 2026, '2026-11-06'))?.mode).toBe('so_far');
		expect(queries.at(-1)!.values).toEqual([2026, '2026-11-06']);
		expect(await loadWrapped(sql, 2024, '2026-11-06')).toBeNull();
		expect(queries.filter((q) => q.text.includes('hub.wrapped_payload'))).toHaveLength(1); // never live for a past year
		await expect(loadWrapped(sql, 2016, '2026-11-06')).rejects.toBeInstanceOf(BadInput);
	});

	it('requestBuild: job with one dedupe key per year; never this year', async () => {
		const { sql, queries } = fakeSql((q) => (q.text.startsWith('INSERT INTO hub_jobs') ? [{ id: 'j1', kind: 'wrapped_build', payload: { year: 2024 }, status: 'queued', attempts: 0, requested_at: new Date(), started_at: null, finished_at: null, result: null, error: null, run_url: null }] : []));
		const ff = fakeFetch(() => ({ status: 204 }));
		const cfg = { githubDispatchToken: 't', githubRepository: 'o/r' };
		const r = await requestBuild(sql, cfg, 2024, '2026-11-06');
		expect(r.mode).toBe('job');
		const ins = queries.find((q) => q.text.startsWith('INSERT INTO hub_jobs'))!;
		expect(ins.values).toContain('wrapped_build');
		expect(ins.values).toContain('wrapped:2024');
		void ff;
		await expect(requestBuild(sql, cfg, 2026, '2026-11-06')).rejects.toBeInstanceOf(BadInput);
		const inline = fakeSql((q) => (q.text.includes('hub.wrapped_freeze') ? [{ r: { year: 2024, created: true, generatedAt: 'x', buildMs: 5 } }] : []));
		expect(await requestBuild(inline.sql, { githubDispatchToken: '', githubRepository: 'o/r' }, 2024, '2026-11-06')).toEqual({
			mode: 'inline',
			result: { year: 2024, created: true, generatedAt: 'x', buildMs: 5 }
		});
	});

	function setup(liveName: string, mirrored: boolean) {
		const ff = fakeFetch((req) => {
			const p = req.url.pathname;
			if (req.method === 'GET' && p === '/v1/me/playlists') return { status: 200, body: { items: [], next: null } };
			if (req.method === 'POST' && p === '/v1/me/playlists') return { status: 201, body: { id: PL, name: (req.body as { name: string }).name } };
			if (req.method === 'GET' && p === `/v1/playlists/${PL}`) return { status: 200, body: { id: PL, name: liveName, owner: { id: OWNER }, snapshot_id: 's' } };
			if (p === `/v1/playlists/${PL}/items`) return { status: req.method === 'POST' ? 201 : 200, body: { snapshot_id: 'n' } };
			if (req.method === 'PUT' && p === '/v1/me/player/play') return { status: 204 };
			return undefined;
		});
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('FROM wrapped_snapshots')) return [{ payload: payload() }];
			if (q.text.includes('FROM spotify_playlists WHERE name =')) return mirrored ? [{ playlist_id: PL }] : [];
			if (q.text.startsWith('SELECT now()')) return [{ now: new Date() }];
			return [];
		});
		const api = new SpotifyApi({ getToken: async () => 'tok', fetch: ff.fetch });
		return { deps: { sql, api, guard: createWriteGuard(api, OWNER), ownerId: OWNER }, calls: ff.calls, queries };
	}

	it('Play your top 100: creates "Wrapped 2025 · Auto 🤖📸", guarded replace of 100 tracks, then plays it', async () => {
		const { deps, calls } = setup('Wrapped 2025 · Auto 🤖📸', false);
		const r = await playTop100(deps, { year: 2025, today: '2026-11-06', deviceId: 'dev-iphone' });
		expect(r).toMatchObject({ playlistId: PL, name: 'Wrapped 2025 · Auto 🤖📸', trackCount: 100, created: true, contextUri: `spotify:playlist:${PL}` });
		const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.pathname}`);
		expect(writes).toEqual(['POST /v1/me/playlists', `PUT /v1/playlists/${PL}/items`, 'PUT /v1/me/player/play']);
		expect((calls.find((c) => c.method === 'POST')!.body as { name: string }).name).toBe('Wrapped 2025 · Auto 🤖📸');
		expect((calls.find((c) => c.method === 'PUT' && c.url.pathname.endsWith('/items'))!.body as { uris: string[] }).uris).toHaveLength(100);
		const play = calls.find((c) => c.url.pathname === '/v1/me/player/play')!;
		expect(play.url.searchParams.get('device_id')).toBe('dev-iphone');
	});

	it('a second press replaces the same playlist (no new one)', async () => {
		const { deps, calls } = setup('Wrapped 2025 · Auto 🤖📸', true);
		const r = await playTop100(deps, { year: 2025, today: '2026-11-06', deviceId: null });
		expect(r.created).toBe(false);
		expect(calls.some((c) => c.method === 'POST' && c.url.pathname === '/v1/me/playlists')).toBe(false);
	});

	it('refuses when Spotify says the playlist is not a snapshot (renamed / spoofed): nothing written', async () => {
		for (const live of ['Wrapped 2025', 'Wrapped 2025 · Auto 🤖🔄', 'Wrapped 2025 · Custom 🎧']) {
			const { deps, calls } = setup(live, true);
			await expect(playTop100(deps, { year: 2025, today: '2026-11-06', deviceId: null })).rejects.toBeInstanceOf(ReadOnlyPlaylist);
			expect(calls.filter((c) => c.method !== 'GET'), live).toEqual([]);
		}
	});

	it('snapshot Rebuild refuses a Wrapped playlist (it has no snapshot definition)', async () => {
		const { sql, queries } = fakeSql((q) =>
			q.text.includes('FROM spotify_playlists') ? [{ playlist_id: PL, name: 'Wrapped 2025 · Auto 🤖📸', owner_id: OWNER, is_owned: true, managed_kind: 'auto_snapshot', removed_at: null }] : []
		);
		await expect(requestRebuild(sql, PL)).rejects.toBeInstanceOf(BadInput);
		expect(queries.some((q) => q.text.includes('INSERT INTO playlist_settings'))).toBe(false);
	});
});

describe('bypass scan covers R6 modules', () => {
	it('no R6 module touches the Spotify write path directly', () => {
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
				}
			}
		};
		walk(root);
		for (const f of [
			'lib/server/wrapped.ts',
			'lib/server/managed-playlist.ts',
			'lib/shared/wrapped.ts',
			'lib/wrapped/cards.ts',
			'lib/components/wrapped/Story.svelte',
			'routes/api/wrapped/+server.ts',
			'routes/api/wrapped/[year]/+server.ts',
			'routes/api/wrapped/[year]/freeze/+server.ts',
			'routes/api/wrapped/[year]/play/+server.ts',
			'routes/(app)/wrapped/[year]/+page.svelte',
			'routes/(app)/stats/wrapped/+page.svelte'
		]) {
			expect(scanned).toContain(f);
		}
		expect(offenders).toEqual([]);
	});
});
