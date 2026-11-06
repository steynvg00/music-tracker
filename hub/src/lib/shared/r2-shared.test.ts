import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BadInput, DEFAULT_FILTERS, customFullName, expiresFor, filtersSummary, parseFilters, ttlLabel, validateCustomName } from './custom';
import { nextRun } from './cron';
import { chipOf, filterRows, groupByCategory, sortRows, type LibraryRow } from './library';
import { ORDER_PREFS } from './order-prefs';
import { parseSubscription } from '$lib/server/push';

describe('custom filters', () => {
	it('normalises and dedupes', () => {
		expect(parseFilters({ artists: [' Da Tweekaz ', 'Da Tweekaz', ''], min_plays: '10', max_tracks: 50, liked_only: true })).toEqual({
			...DEFAULT_FILTERS,
			artists: ['Da Tweekaz'],
			min_plays: 10,
			max_tracks: 50,
			liked_only: true
		});
		expect(parseFilters({})).toEqual(DEFAULT_FILTERS);
	});
	it.each([
		[{ sort_order: 'DROP TABLE' }],
		[{ min_plays: 0 }],
		[{ max_tracks: 20000 }],
		[{ release_year_min: 2020, release_year_max: 2010 }],
		[{ artists: 'Da Tweekaz' }],
		[[]]
	])('rejects %j', (input) => {
		expect(() => parseFilters(input)).toThrow(BadInput);
	});
	it('summary matches lib/temporary_playlists.build_filters_summary (golden values from Python)', () => {
		expect(
			filtersSummary(parseFilters({ artists: ['Da Tweekaz', 'The Elite', 'Hard Driver', 'N-Vitral'], release_year_min: 2015, discovery_year_max: 2021, min_plays: 10, liked_only: true, sort_order: 'random' }))
		).toBe('artists=Da Tweekaz, The Elite, Hard Driver+; release=2015-*; discovered=*-2021; plays>=10; liked only; sort=random');
		expect(filtersSummary(DEFAULT_FILTERS)).toBe('sort=plays_desc');
		expect(filtersSummary(parseFilters({ artists: ['A'], release_year_max: 2020, discovery_year_min: 2019, discovery_year_max: 2019, sort_order: 'release_asc' }))).toBe(
			'artists=A; release=*-2020; discovered=2019-2019; sort=release_asc'
		);
	});
	it('names: the suffix is added by Rotor and cannot be typed in', () => {
		expect(customFullName(validateCustomName('  Smoke   test '))).toBe('Smoke test · Custom 🎧');
		for (const bad of ['', ' ', 'x · Custom 🎧', 'x · Auto 🤖🔄', 'a'.repeat(81), 'bell\u0007here']) expect(() => validateCustomName(bad)).toThrow(BadInput);
	});
	it('lifetimes and the TTL chip', () => {
		const now = new Date('2026-11-05T10:00:00Z');
		expect(expiresFor('7d', now)?.toISOString()).toBe('2026-11-12T10:00:00.000Z');
		expect(expiresFor('keep', now)).toBeNull();
		expect(ttlLabel(null)).toBe('Kept');
		expect(ttlLabel('2026-11-08T09:00:00Z', now.getTime())).toBe('Deletes in 3 d');
	});
});

describe('nextRun (cron, UTC)', () => {
	const from = new Date('2026-11-05T12:00:00Z'); // Thursday
	it.each([
		['0 6 * * 1', '2026-11-09T06:00:00.000Z'],
		['0 6 1 * *', '2026-12-01T06:00:00.000Z'],
		['0 6 15 * *', '2026-11-15T06:00:00.000Z'],
		['0 3 * * *', '2026-11-06T03:00:00.000Z'],
		['47 5 * * *', '2026-11-06T05:47:00.000Z'],
		['0 12 * * *', '2026-11-06T12:00:00.000Z']
	])('%s → %s', (expr, iso) => expect(nextRun(expr, from)?.toISOString()).toBe(iso));
	it('rejects what it does not understand', () => {
		expect(nextRun('*/30 * * * *', from)).toBeNull();
		expect(nextRun('', from)).toBeNull();
	});
});

const row = (over: Partial<LibraryRow>): LibraryRow => ({
	id: 'x',
	uri: 'spotify:playlist:x',
	name: 'x',
	imageUrl: null,
	kind: null,
	isOwned: true,
	isCollab: false,
	ownerName: null,
	trackCount: 10,
	category: null,
	expiresAt: null,
	lastPlayedOn: null,
	rotationScore: null,
	...over
});

describe('library', () => {
	const rows = [
		row({ id: 'a', name: 'Top 30 · Auto 🤖🔄', kind: 'auto_updating', category: 'top_recent_30d', trackCount: 30 }),
		row({ id: 'b', name: 'Top 25 · March 2021 · Auto 🤖📸', kind: 'auto_snapshot', category: 'snapshot_month', trackCount: 25 }),
		row({ id: 'c', name: 'Gym · Custom 🎧', kind: 'custom', trackCount: 72, lastPlayedOn: '2026-11-01' }),
		row({ id: 'd', name: 'Road trip', trackCount: 83, rotationScore: 0.7 }),
		row({ id: 'e', name: 'Followed mix', isOwned: false, trackCount: null, rotationScore: 0.9 })
	];
	it('chips', () => {
		expect(rows.map(chipOf)).toEqual(['managed', 'snapshots', 'custom', 'yours', 'followed']);
		expect(filterRows(rows, new Set()).length).toBe(5);
		expect(filterRows(rows, new Set(['custom', 'yours'] as const)).map((r) => r.id)).toEqual(['c', 'd']);
		expect(filterRows(rows, new Set(['liked'] as const))).toEqual([]);
	});
	it('sorts', () => {
		expect(sortRows(rows, 'az').map((r) => r.id)).toEqual(['e', 'c', 'd', 'b', 'a']);
		expect(sortRows(rows, 'tracks')[0]!.id).toBe('d');
		expect(sortRows(rows, 'rotation')[0]!.id).toBe('e');
		expect(sortRows(rows, 'recent')[0]!.id).toBe('c');
	});
	it('groups managed playlists by rule category in catalog order', () => {
		const g = groupByCategory(rows.slice(0, 2), [
			{ key: 'top_recent_30d', name: 'Top 30' },
			{ key: 'snapshot_month', name: 'Top 25 per maand' }
		]);
		expect(g.map((x) => [x.key, x.rows.length])).toEqual([
			['top_recent_30d', 1],
			['snapshot_month', 1]
		]);
	});
});

describe('order preferences match lib/playlist_settings.py', () => {
	it('same keys and labels', () => {
		const py = readFileSync(fileURLToPath(new URL('../../../../lib/playlist_settings.py', import.meta.url)), 'utf8');
		const block = py.slice(py.indexOf('ORDER_PREF_OPTIONS'), py.indexOf('}', py.indexOf('ORDER_PREF_OPTIONS')));
		const pairs = Object.fromEntries([...block.matchAll(/"([a-z_]+)":\s+"([^"]+)"/g)].map((m) => [m[1], m[2]]));
		expect(pairs).toEqual(ORDER_PREFS);
	});
});

describe('push subscriptions', () => {
	const ok = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
	it('accepts a real-shaped subscription', () => {
		expect(parseSubscription(ok)).toMatchObject({ endpoint: ok.endpoint, deviceLabel: null });
	});
	it.each([{ ...ok, endpoint: 'http://insecure.example' }, { ...ok, endpoint: 'not a url' }, { ...ok, keys: { p256dh: 'x', auth: 'y' } }])('rejects %j', (b) => {
		expect(() => parseSubscription(b as Record<string, unknown>)).toThrow(BadInput);
	});
});
