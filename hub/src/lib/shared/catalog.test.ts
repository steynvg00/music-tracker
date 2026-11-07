import { describe, expect, it } from 'vitest';
import {
	byYear,
	dateKey,
	fmtReleaseDate,
	longCover,
	myState,
	ownTracks,
	packOwnTrack,
	packRelease,
	pickImage,
	shortCover,
	sortReleases,
	toRelease,
	toTrack,
	typeLabel,
	unpackOwnTrack,
	unpackRelease,
	type Release
} from './catalog';

const rel = (id: string, date: string | null, name = id): Release => ({ id, name, date, precision: null, group: 'album', type: 'album', cover: null, total: 10 });

describe('v0.90 catalog: storage encoding', () => {
	it('round-trips a release through the packed form and strips the fixed cover prefix', () => {
		const r: Release = { id: 'a'.repeat(22), name: 'Rise', date: '2015-03', precision: 'month', group: 'appears_on', type: 'compilation', cover: 'https://i.scdn.co/image/ab67616d00001e02' + 'f'.repeat(24), total: 42 };
		const p = packRelease(r);
		expect(p[6]).toBe('ab67616d00001e02' + 'f'.repeat(24));
		expect(p[4]).toBe('p');
		expect(unpackRelease(p)).toEqual(r);
	});
	it('keeps unknown cover hosts whole', () => {
		expect(shortCover('https://example.org/x.jpg')).toBe('https://example.org/x.jpg');
		expect(longCover('https://example.org/x.jpg')).toBe('https://example.org/x.jpg');
		expect(shortCover(null)).toBeNull();
	});
	it('packs an own track as [id, name, number, duration] only', () => {
		const t = toTrack({ id: 'b'.repeat(22), name: 'Echo', track_number: 3, duration_ms: 201000, artists: [{ id: 'c'.repeat(22), name: 'X' }] });
		expect(packOwnTrack(t)).toEqual(['b'.repeat(22), 'Echo', 3, 201000]);
		expect(unpackOwnTrack(packOwnTrack(t), { id: 'c'.repeat(22), name: 'X' }).uri).toBe(`spotify:track:${'b'.repeat(22)}`);
	});
	it('picks ONE cover size, the one nearest 300 px', () => {
		expect(pickImage([{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }])).toBe('mid');
		expect(pickImage([])).toBeNull();
	});
	it('maps a Spotify album object without album_group (Feb 2026) using the requested group', () => {
		const r = toRelease({ id: 'd'.repeat(22), name: 'N', album_type: 'single', total_tracks: 5, release_date: '2020', release_date_precision: 'year', images: [] }, 'single');
		expect(r).toMatchObject({ group: 'single', type: 'single', total: 5, precision: 'year' });
		expect(typeLabel(r)).toBe('EP');
	});
});

describe('v0.90 catalog: appears-on filtering', () => {
	it('keeps only tracks that credit the artist by id', () => {
		const me = 'm'.repeat(22);
		const list = [
			{ id: '1', name: 'a', artists: [{ id: 'x'.repeat(22), name: 'Other' }] },
			{ id: '2', name: 'b', artists: [{ id: 'x'.repeat(22), name: 'Other' }, { id: me, name: 'Me' }] },
			{ id: '3', name: 'c', artists: [{ id: null, name: 'Me' }] }
		];
		expect(ownTracks(list, me).map((t) => t.id)).toEqual(['2']);
	});
});

describe('v0.90 catalog: sorting and year headers', () => {
	const list = [rel('a', '2015'), rel('b', '2015-03-01'), rel('c', '2021-11'), rel('d', null), rel('e', '2019-06-07')];
	it('normalises partial dates', () => {
		expect(dateKey('2015')).toBe('2015-00-00');
		expect(dateKey('2015-03')).toBe('2015-03-00');
		expect(dateKey(null)).toBe('');
	});
	it('newest first, undated last', () => {
		expect(sortReleases(list, 'newest').map((r) => r.id)).toEqual(['c', 'e', 'b', 'a', 'd']);
	});
	it('oldest first, undated still last', () => {
		expect(sortReleases(list, 'oldest').map((r) => r.id)).toEqual(['a', 'b', 'e', 'c', 'd']);
	});
	it('groups consecutive releases under one year header', () => {
		const blocks = byYear(sortReleases(list, 'newest'));
		expect(blocks.map((b) => [b.year, b.items.length])).toEqual([
			['2021', 1],
			['2019', 1],
			['2015', 2],
			['Unknown year', 1]
		]);
	});
	it('is stable for equal dates (name, then id)', () => {
		expect(sortReleases([rel('z', '2020', 'B'), rel('y', '2020', 'A')], 'newest').map((r) => r.id)).toEqual(['y', 'z']);
	});
});

describe('v0.90 catalog: my state + dates', () => {
	it('liked beats played beats not heard', () => {
		expect(myState(0, true)).toBe('liked');
		expect(myState(3, false)).toBe('played');
		expect(myState(0, false)).toBe('not_heard');
	});
	it('formats by precision', () => {
		expect(fmtReleaseDate('2015', 'year')).toBe('2015');
		expect(fmtReleaseDate('2015-03', 'month')).toBe('Mar 2015');
		expect(fmtReleaseDate('2015-03-07', 'day')).toBe('7 Mar 2015');
		expect(fmtReleaseDate(null, null)).toBe('Unknown date');
	});
});
