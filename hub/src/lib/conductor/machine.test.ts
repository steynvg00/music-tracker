import { describe, expect, it } from 'vitest';
import { median, nextRun, observe, precheck, runAt, runUris, runs, type Expect, type MixItem } from './machine';

const S = (n: number): MixItem => ({ position: n, source: 'spotify', spotifyUri: `spotify:track:${String(n).padStart(22, '0')}`, mediaItemId: null, sourceId: null, title: `s${n}`, artist: null, durationMs: 5000 });
const Y = (n: number, skip = false): MixItem => ({ position: n, source: 'youtube', spotifyUri: null, mediaItemId: `m${n}`, sourceId: `vid${n}`, title: `y${n}`, artist: null, durationMs: 5000, skip });
const C = (n: number): MixItem => ({ ...Y(n), source: 'soundcloud', sourceId: `https://soundcloud.com/a/t${n}` });
const uri = (n: number) => S(n).spotifyUri!;

describe('runs', () => {
	it('groups S-S-YT-S-SC-S into five runs', () => {
		const items = [S(0), S(1), Y(2), S(3), C(4), S(5)];
		expect(runs(items).map((r) => `${r.source}:${r.start}-${r.end}`)).toEqual(['spotify:0-1', 'youtube:2-2', 'spotify:3-3', 'soundcloud:4-4', 'spotify:5-5']);
	});
	it('a skipped in-app item between two Spotify items joins them into one run', () => {
		const items = [S(0), Y(1, true), S(2), Y(3)];
		const rs = runs(items);
		expect(rs.map((r) => `${r.source}:${r.start}-${r.end}`)).toEqual(['spotify:0-2', 'youtube:3-3']);
		expect(runUris(items, rs[0]!)).toEqual([uri(0), uri(2)]);
		expect(runAt(rs, 2)).toBe(rs[0]);
		expect(nextRun(rs, rs[0]!)).toBe(rs[1]);
		expect(nextRun(rs, rs[1]!)).toBeNull();
	});
});

describe('precheck (F5: same output device)', () => {
	it('laptop needs This laptop (the SDK device)', () => {
		expect(precheck('laptop', { id: 'sdk', name: 'This laptop', type: 'Computer' }, 'sdk')).toEqual({ ok: true });
		expect(precheck('laptop', { id: 'spk', name: 'Living room', type: 'Speaker' }, 'sdk')).toEqual({ ok: false, reason: 'other_device', deviceName: 'Living room' });
		expect(precheck('laptop', null, 'sdk')).toMatchObject({ reason: 'no_device' });
	});
	it('relay mode needs the phone', () => {
		expect(precheck('relay', { id: 'p', name: 'iPhone', type: 'Smartphone' }, null)).toEqual({ ok: true });
		expect(precheck('relay', { id: 's', name: 'Living room', type: 'Speaker' }, null)).toMatchObject({ ok: false });
	});
});

const observeAt = (e: Expect, s: Parameters<typeof observe>[1]) => observe(e, s, 100_000);

describe('observe a Spotify run', () => {
	const NOW = 100_000;
	// started 1 s ago by default
	const base: Expect = { uris: [uri(0), uri(1)], index: 0, itemStartedAt: NOW - 1000, duration: 5000, starting: false };
	const at = (msAgo: number) => NOW - msAgo;
	const snap = (u: string | null, playing: boolean, progress = 0, ctx: string | null = null) => ({ isPlaying: playing, itemUri: u, progressMs: progress, durationMs: 5000, contextUri: ctx });
	it('waits for the run to start, then follows it', () => {
		expect(observeAt({ ...base, starting: true }, snap(null, false))).toEqual({ kind: 'waiting' });
		expect(observeAt({ ...base, starting: true }, snap(uri(0), true))).toEqual({ kind: 'playing', index: 0 });
		expect(observeAt(base, snap(uri(0), true, 2000))).toEqual({ kind: 'playing', index: 0 });
	});
	it('a late poll still sees a natural advance: elapsed time counts, not the last polled progress', () => {
		// last poll saw 1 s of a 5 s track, the next poll comes 5.2 s after the start: natural.
		expect(observeAt({ ...base, itemStartedAt: at(5200) }, snap(uri(1), true, 200))).toEqual({ kind: 'playing', index: 1 });
	});
	it('a natural advance near the end is fine; a skip mid-track is divergence (F6)', () => {
		expect(observeAt({ ...base, itemStartedAt: at(4500) }, snap(uri(1), true, 200))).toEqual({ kind: 'playing', index: 1 });
		expect(observeAt({ ...base, itemStartedAt: at(1500) }, snap(uri(1), true, 200))).toEqual({ kind: 'diverged', why: 'skipped' });
	});
	it('stopping on the last track at its end is the run end', () => {
		expect(observeAt({ ...base, index: 1, itemStartedAt: at(4800) }, snap(uri(1), false, 0))).toEqual({ kind: 'run_end' });
		expect(observeAt({ ...base, index: 1, itemStartedAt: at(2000) }, snap(uri(1), false, 2000))).toEqual({ kind: 'paused' });
	});
	it('Spotify autoplay after our last track is detected (F3); anything else is divergence', () => {
		expect(observeAt({ ...base, index: 1, itemStartedAt: at(4900) }, snap('spotify:track:radioradioradioradio01', true))).toEqual({ kind: 'autoplay' });
		expect(observeAt({ ...base, index: 0 }, snap('spotify:track:radioradioradioradio01', true))).toEqual({ kind: 'diverged', why: 'other' });
		expect(observeAt(base, snap(uri(0), true, 1000, 'spotify:playlist:x'))).toEqual({ kind: 'diverged', why: 'context' });
	});
});

describe('median', () => {
	it('of the handoff gaps', () => {
		expect(median([])).toBeNull();
		expect(median([900, 1500, 3000])).toBe(1500);
		expect(median([1000, 2000])).toBe(1500);
	});
});
