import { describe, expect, it } from 'vitest';
import { dupeKey, isPlaceholder, parseDuration, parseEmbedTitle, similar, soundcloudUrl, validateOwnTrack, youtubeId, fmtClock } from './own';
import { entryIndexAt, parseTracklist, validateSet } from './sets';
import { checkFile, partCount, partRange, remainingParts, uploadMode, usage } from './media';

const SP = '0TnOYISbd1XYRBk9myaseg';
const RO = '2d2c6f0e-1f7a-4b39-9a35-6f1c0b1c2d3e';
const good = () => ({
	title: 'Night Drive',
	status: 'unreleased',
	durationMs: '6:12',
	artists: { primary: [{ kind: 'spotify', id: SP, name: 'Pitbull' }] },
	youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ'
});

describe('placeholders', () => {
	it.each(['unknown', ' Unknown Artist ', '?', '???', 'ID - ID', 'id – id', 'TBA', 'n/a', '-', '…', '', '   ', 'untitled'])('rejects %j', (v) => expect(isPlaceholder(v)).toBe(true));
	it.each(['ID Please', 'Idris', 'Unknown Pleasures', 'X', '1999', '?!Question'])('accepts %j', (v) => expect(isPlaceholder(v)).toBe(false));
});

describe('validateOwnTrack (V094-01 required fields)', () => {
	it('accepts a complete track and normalises it', () => {
		const r = validateOwnTrack(good());
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.durationMs).toBe(372_000);
			expect(r.value.youtubeId).toBe('dQw4w9WgXcQ');
		}
	});
	it('reports every missing field at once', () => {
		const r = validateOwnTrack({});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['artists', 'duration', 'source', 'status', 'title']);
	});
	it('rejects placeholders and empty duration', () => {
		const r = validateOwnTrack({ ...good(), title: 'Unknown', durationMs: '', artists: { primary: [{ kind: 'rotor', id: RO, name: 'ID - ID' }] } });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors.title).toContain('placeholder');
			expect(r.errors.duration).toBeTruthy();
			expect(r.errors.artists).toBeTruthy();
		}
	});
	it('rejects free-text artists (must be linked)', () => {
		const r = validateOwnTrack({ ...good(), artists: { primary: [{ name: 'Someone' }] } });
		expect(r.ok || r.errors.artists).toBeTruthy();
		expect(r.ok).toBe(false);
	});
	it('needs at least one valid source', () => {
		const r = validateOwnTrack({ ...good(), youtubeUrl: 'https://vimeo.com/1' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.youtube).toBeTruthy();
	});
	it('a heard-at timestamp needs a set', () => {
		const r = validateOwnTrack({ ...good(), heardAtMs: '1:00:00' });
		expect(r.ok).toBe(false);
	});
});

describe('links + durations', () => {
	it('parses YouTube and SoundCloud links', () => {
		expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://youtube.com/playlist?list=PL1')).toBeNull();
		expect(soundcloudUrl('https://m.soundcloud.com/artist/track-1?si=x')).toBe('https://soundcloud.com/artist/track-1');
		expect(soundcloudUrl('https://soundcloud.com/artist/likes')).toBeNull();
	});
	it('durations', () => {
		expect(parseDuration('1:02:03')).toBe(3_723_000);
		expect(parseDuration('3:75')).toBeNull();
		expect(parseDuration('abc')).toBeNull();
		expect(fmtClock(3_723_000)).toBe('1:02:03');
	});
});

describe('duplicates (V094-02)', () => {
	it('dupe key ignores case, accents, feat. and Original Mix', () => {
		expect(dupeKey(['Tiësto', 'Karol G'], 'Don’t Be Shy', 'Original Mix')).toBe(dupeKey(['karol g', 'TIESTO'], "Don't be shy (feat. X)", null));
		expect(dupeKey(['A'], 'T', 'Extended Mix')).not.toBe(dupeKey(['A'], 'T', 'Radio Edit'));
	});
	it('similar = same title + an overlapping artist', () => {
		expect(similar({ title: 'Night Drive (Extended Mix)', artists: ['DJ A'] }, { title: 'night drive', artists: ['dj a', 'B'] })).toBe(true);
		expect(similar({ title: 'Night Drive', artists: ['DJ A'] }, { title: 'Night Drive', artists: ['C'] })).toBe(false);
	});
});

describe('embed titles', () => {
	it('splits artist, title, version, featuring, remixer', () => {
		expect(parseEmbedTitle('Artist A & Artist B - Song Name (feat. Singer) (Extended Mix) [Official Video]')).toEqual({
			artists: ['Artist A', 'Artist B'],
			featuring: ['Singer'],
			title: 'Song Name',
			version: 'Extended Mix',
			remixer: null
		});
		expect(parseEmbedTitle('Track (Somebody Remix)', 'Producer - Topic')).toMatchObject({ artists: ['Producer'], title: 'Track', remixer: 'Somebody', version: 'Somebody Remix' });
		expect(parseEmbedTitle('ID - ID').artists).toEqual([]);
	});
});

describe('tracklist parser + seek (V094-08)', () => {
	const text = `Tracklist:
00:00 Artist One - First Track
[03:45] Artist Two – Second Track (Extended Mix)
1:02:03 ID - ID
01. Artist Four - Fourth (1:10:00)
5. Artist Five - Fifth
# comment

12:00 - Artist Six - Six`;
	it('reads the common formats', () => {
		const p = parseTracklist(text);
		expect(p.map((x) => [x.startMs, x.artist, x.title, x.isId])).toEqual([
			[0, 'Artist One', 'First Track', false],
			[225_000, 'Artist Two', 'Second Track (Extended Mix)', false],
			[3_723_000, 'ID', 'ID', true],
			[4_200_000, 'Artist Four', 'Fourth', false],
			[null, 'Artist Five', 'Fifth', false],
			[720_000, 'Artist Six', 'Six', false]
		]);
	});
	it('finds the entry playing at a position', () => {
		const e = [{ startMs: 0 }, { startMs: 225_000 }, { startMs: null }, { startMs: 720_000 }];
		expect(entryIndexAt(e, 300_000)).toBe(1);
		expect(entryIndexAt(e, 720_000)).toBe(3);
		expect(entryIndexAt([{ startMs: 10 }], 0)).toBe(-1);
	});
	it('validates a set: one source, linked DJs, entries inside the set', () => {
		const base = { title: 'Live at X', artists: [{ kind: 'spotify', id: SP, name: 'DJ' }], durationMs: '1:30:00', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' };
		expect(validateSet(base).ok).toBe(true);
		expect(validateSet({ ...base, soundcloudUrl: 'https://soundcloud.com/a/b' }).ok).toBe(false);
		const r = validateSet({ ...base, tracklist: [{ startMs: '2:00:00', kind: 'id', title: 'ID' }] });
		expect(r.ok).toBe(false);
		const ok = validateSet({ ...base, tracklist: [{ startMs: '0:00', kind: 'id', title: '' }, { startMs: 60_000, kind: 'catalog', trackUri: `spotify:track:${SP}`, title: 'X' }] });
		expect(ok.ok && ok.value.tracklist.map((t) => t.title)).toEqual(['ID', 'X']);
	});
});

describe('uploads (V094-03/04 planning, V094-05 limits)', () => {
	const l = { trackBytes: 50 * 2 ** 20, setBytes: 400 * 2 ** 20, coverBytes: 5 * 2 ** 20, quotaBytes: 2 ** 30, partBytes: 8 * 2 ** 20 };
	it('type + size per purpose', () => {
		expect(checkFile('track', { name: 'a.MP3', size: 10, type: 'audio/mpeg' }, l)).toEqual({ ok: true, ext: 'mp3', contentType: 'audio/mpeg' });
		expect(checkFile('track', { name: 'a.flac', size: 10, type: '' }, l).ok).toBe(true);
		expect(checkFile('track', { name: 'a.ogg', size: 10, type: 'audio/ogg' }, l).ok).toBe(false);
		expect(checkFile('track', { name: 'a.mp3', size: 10, type: 'video/mp4' }, l).ok).toBe(false);
		expect(checkFile('track', { name: 'a.wav', size: 51 * 2 ** 20 }, l).ok).toBe(false);
		expect(checkFile('set', { name: 'a.wav', size: 399 * 2 ** 20 }, l).ok).toBe(true);
		expect(checkFile('cover', { name: 'c.jpeg', size: 10, type: 'image/jpeg' }, l)).toMatchObject({ ok: true, ext: 'jpg' });
	});
	it('multipart planning + resume', () => {
		expect(uploadMode(6 * 2 ** 20, l.partBytes)).toBe('single');
		expect(uploadMode(9 * 2 ** 20, l.partBytes)).toBe('multipart');
		expect(partCount(17 * 2 ** 20, l.partBytes)).toBe(3);
		expect(partRange(3, 17 * 2 ** 20, l.partBytes)).toEqual([16 * 2 ** 20, 17 * 2 ** 20]);
		expect(remainingParts(4, [1, 3])).toEqual([2, 4]);
	});
	it('usage warns at 80 %', () => {
		expect(usage(800, 1000, { track: 1, set: 0, cover: 0 }, 0)).toMatchObject({ pct: 80, warn: true, full: false });
		expect(usage(799, 1000, { track: 1, set: 0, cover: 0 }, 0).warn).toBe(false);
	});
});
