import { describe, expect, it } from 'vitest';
import { isPublicPath, originAllowed } from './access';
import { nextRank, toCandidate } from './daily';
import { ingestHealth, loadTiles, suggestedSubtitle } from './home';
import { fakeSql } from './test-helpers';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isIsoDate, localDate } from './time';
import { toMirrorRow } from './spotify/mirror';
import { wakeAndRun } from './wake';
import { TtlCache } from './stats';
import type { PlayerDevice } from '$lib/shared/player-types';

describe('access', () => {
	it('only login + OAuth + PWA plumbing are public', () => {
		for (const p of ['/login', '/auth/login', '/auth/callback', '/service-worker.js', '/manifest.webmanifest', '/icons/icon-192.png'])
			expect(isPublicPath(p)).toBe(true);
		for (const p of ['/', '/home', '/api/player/state', '/api/spotify/token', '/auth/logout', '/settings', '/icons/../api'])
			expect(isPublicPath(p)).toBe(false);
	});
	it('mutating requests need our own Origin', () => {
		expect(originAllowed('POST', 'https://rotor.example', 'https://rotor.example')).toBe(true);
		expect(originAllowed('POST', 'https://evil.example', 'https://rotor.example')).toBe(false);
		expect(originAllowed('DELETE', null, 'https://rotor.example')).toBe(false);
		expect(originAllowed('GET', null, 'https://rotor.example')).toBe(true);
	});
});

describe('daily', () => {
	it('nextRank walks the deck and ends', () => {
		expect(nextRank([1, 2, 3, 4, 5], 1)).toBe(2);
		expect(nextRank([5, 1, 3], 3)).toBe(5);
		expect(nextRank([1, 2, 3, 4, 5], 5)).toBeNull();
	});
	it('toCandidate shapes generated and existing rows', () => {
		const base = {
			pick_date: new Date('2026-11-04T00:00:00Z'),
			params: {},
			p_name: null,
			p_image_url: null,
			p_track_count: null,
			p_is_owned: null,
			p_is_collab: null,
			p_owner_name: null,
			p_managed_kind: null
		};
		const g = toCandidate({ ...base, rank: 1, kind: 'generated', recipe: 'forgotten_gems', playlist_id: null, title: 'Forgotten gems', reason: 'r', track_uris: ['a', 'b'], duration_ms: '480000' });
		expect(g).toMatchObject({ date: '2026-11-04', trackCount: 2, durationMs: 480000, playlist: null });
		const e = toCandidate({ ...base, rank: 2, kind: 'existing_playlist', recipe: null, playlist_id: '37i9dQZF1DXcBWIGoYBM5M', title: 'Road trip', reason: 'r', track_uris: null, duration_ms: null, p_name: 'Road trip', p_track_count: 83, p_is_owned: true });
		expect(e.playlist).toMatchObject({ uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', isOwned: true, trackCount: 83 });
	});
});

describe('home helpers', () => {
	const now = new Date('2026-11-04T12:00:00Z');
	it('ingest health: amber after 24 h, red after 72 h', () => {
		expect(ingestHealth(new Date('2026-11-04T08:00:00Z'), now)).toBe('ok');
		expect(ingestHealth(new Date('2026-11-03T08:00:00Z'), now)).toBe('warn');
		expect(ingestHealth(new Date('2026-10-31T08:00:00Z'), now)).toBe('danger');
		expect(ingestHealth(null, now)).toBe('danger');
	});
	it('suggestedSubtitle', () => {
		expect(suggestedSubtitle('2026-09-24', '2026-11-04', false)).toBe('Last suggested 41 d ago');
		expect(suggestedSubtitle(null, '2026-11-04', true)).toBe('Play only · followed');
	});
});

// API-ingested plays have ms_played = NULL. Every hours/ms total must fall back to the track
// length, or a month of API plays reads "0 h" (migration 0026).
describe('listening time for plays without ms_played', () => {
	it('week hours: sums coalesce(ms_played, track_metadata.duration_ms)', async () => {
		const { sql, queries } = fakeSql((q) =>
			q.text.includes('ms_week') ? [{ plays_week: 3, ms_week: '5400000', plays_prev: 2, month_label: 'Nov' }] : []
		);
		const tiles = await loadTiles(sql);
		expect(tiles.hoursThisWeek).toBe(1.5);
		const q = queries.find((x) => x.text.includes('ms_week'))!.text;
		expect(q).toContain('sum(coalesce(p.ms_played, tm.duration_ms))');
		expect(q).toContain('LEFT JOIN track_metadata tm ON tm.track_uri = p.track_uri');
		expect(q).not.toMatch(/sum\(p\.ms_played\)/);
	});

	it('the latest definition of every hub rollup that sums ms uses the fallback', () => {
		const dir = join(__dirname, '..', '..', '..', '..', 'migrations');
		const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
		const latest = (re: RegExp) => {
			let body = '';
			for (const f of files) {
				const m = readFileSync(join(dir, f), 'utf8').match(re);
				if (m) body = m[0];
			}
			return body;
		};
		// v0.92 (0035): rebuild_days delegates to hub.merge_days, which holds the aggregates now.
		const rebuild = latest(/FUNCTION hub\.merge_days[\s\S]*?\n\$\$;/) || latest(/FUNCTION hub\.rebuild_days[\s\S]*?\n\$\$;/);
		const trackStats = latest(/MATERIALIZED VIEW hub\.mv_track_stats AS[\s\S]*?GROUP BY 1;/);
		for (const body of [rebuild, trackStats]) {
			expect(body).not.toBe('');
			expect(body).not.toMatch(/sum\((sp\.)?ms_played\)/);
			expect(body).toContain('coalesce(sp.ms_played, tm.duration_ms)');
		}
		expect(rebuild.match(/coalesce\(sp\.ms_played, tm\.duration_ms\)/g)).toHaveLength(3);
	});
});

describe('time', () => {
	it('localDate is Amsterdam', () => {
		expect(localDate(new Date('2026-11-04T23:30:00Z'))).toBe('2026-11-05');
		expect(localDate(new Date('2026-07-01T21:59:00Z'))).toBe('2026-07-01');
	});
	it('isIsoDate', () => {
		expect(isIsoDate('2026-11-04')).toBe(true);
		expect(isIsoDate('2026-11-04; DROP')).toBe(false);
		expect(isIsoDate(20261104)).toBe(false);
	});
});

describe('mirror', () => {
	it('managed kind only for owned playlists; accepts tracks or items totals', () => {
		expect(toMirrorRow({ id: 'a', name: 'Gym · Custom 🎧', owner: { id: 'me' }, tracks: { total: 3 } }, 'me')).toMatchObject({ managed_kind: 'custom', track_count: 3, is_owned: true });
		expect(toMirrorRow({ id: 'b', name: 'Gym · Custom 🎧', owner: { id: 'x' }, items: { total: 9 } }, 'me')).toMatchObject({ managed_kind: null, track_count: 9, is_owned: false });
	});
});

describe('wakeAndRun (pending intent, server half)', () => {
	const phone: PlayerDevice = { id: 'phone-device-id', name: 'iPhone', type: 'Smartphone', isActive: false, isRestricted: false, supportsVolume: false, volumePercent: null };
	it('polls every second and plays as soon as a device appears', async () => {
		let t = 0;
		const lists = [[], [], [phone]];
		const ran: string[] = [];
		const r = await wakeAndRun({
			listDevices: async () => lists.shift() ?? [phone],
			run: async (id) => void ran.push(id),
			prefer: 'Smartphone',
			knownIds: [],
			now: () => t,
			sleep: async (ms) => void (t += ms)
		});
		expect(r).toEqual({ status: 'played', device: phone });
		expect(ran).toEqual(['phone-device-id']);
		expect(t).toBe(2000);
	});
	it('gives up after 12 s without running the intent', async () => {
		let t = 0;
		const ran: string[] = [];
		const r = await wakeAndRun({ listDevices: async () => [], run: async (id) => void ran.push(id), prefer: null, knownIds: [], now: () => t, sleep: async (ms) => void (t += ms) });
		expect(r).toEqual({ status: 'timeout' });
		expect(ran).toEqual([]);
		expect(t).toBeLessThanOrEqual(12_000);
	});
});

describe('TtlCache', () => {
	it('expires entries', () => {
		let t = 0;
		const c = new TtlCache<number>(100, 2, () => t);
		c.set('a', 1);
		expect(c.get('a')).toBe(1);
		t = 101;
		expect(c.get('a')).toBeUndefined();
	});
});

describe('syncMirror', () => {
	it('upserts each playlist once even if pagination repeats it, and guards soft-deletes', async () => {
		const { syncMirror } = await import('./spotify/mirror');
		const { SpotifyApi } = await import('./spotify/api');
		const { fakeFetch, fakeSql } = await import('./test-helpers');
		const pl = (id: string) => ({ id, name: `P ${id}`, owner: { id: 'me' }, snapshot_id: 's', items: { total: 1 } });
		const ff = fakeFetch((req) =>
			req.url.searchParams.get('offset') === '0'
				? { status: 200, body: { items: [pl('A'.repeat(22)), pl('B'.repeat(22))], next: 'more' } }
				: { status: 200, body: { items: [pl('B'.repeat(22)), pl('C'.repeat(22))], next: null } }
		);
		const api = new SpotifyApi({ getToken: async () => 't', fetch: ff.fetch });
		const { sql, queries } = fakeSql((q) => {
			if (q.text.startsWith('SELECT max(last_seen_at)')) return [{ t: null }];
			if (q.text.startsWith('SELECT now()')) return [{ now: new Date() }];
			if (q.text.startsWith('SELECT count(*)::int AS live')) return [{ live: 10 }];
			return [];
		});
		const r = await syncMirror(sql, api, 'me');
		expect(r).toMatchObject({ skipped: false, listed: 3 });
		// 3 of 10 live listed → below half: nothing is soft-deleted this run.
		expect(queries.some((q) => q.text.startsWith('UPDATE spotify_playlists SET removed_at'))).toBe(false);
		expect(queries.filter((q) => q.text.startsWith('INSERT INTO spotify_playlists'))).toHaveLength(1);
	});
});
