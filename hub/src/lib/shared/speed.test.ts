import { describe, expect, it } from 'vitest';
import { RESUME_MAX_AGE_MS, parseSaved, resumable, resumeTarget } from '$lib/resume';
import { tableTone, weekGrowth } from './health';
import { serverTiming, withTimings, record } from '$lib/server/timing';

describe('v0.92 reopen where you left it', () => {
	const now = Date.parse('2026-11-12T20:00:00Z');
	const saved = { path: '/stats/top?range=this_year', scrollY: 640, at: now - 3_600_000 };
	const base = { standalone: true, path: '/home', saved, now, firstLoad: true };
	it('a cold start of the installed app on /home goes back to the saved page', () => {
		expect(resumeTarget(base)).toEqual(saved);
	});
	it('only the installed app, only its first load, only from the start page, only recent', () => {
		expect(resumeTarget({ ...base, standalone: false })).toBeNull();
		expect(resumeTarget({ ...base, firstLoad: false })).toBeNull();
		expect(resumeTarget({ ...base, path: '/library' })).toBeNull();
		expect(resumeTarget({ ...base, saved: { ...saved, at: now - RESUME_MAX_AGE_MS - 1 } })).toBeNull();
	});
	it('never resumes into sign-in or one-off pages; bad storage is ignored', () => {
		expect(resumable('/auth/callback')).toBe(false);
		expect(resumable('/login')).toBe(false);
		expect(resumable('/library?folder=3')).toBe(true);
		expect(parseSaved('{"path":1}')).toBeNull();
		expect(parseSaved('not json')).toBeNull();
	});
});

describe('v0.92 Data health: bloat and growth', () => {
	const hist = [
		{ d: '2026-11-04', t: { 'hub.day_track': 100 } },
		{ d: '2026-11-05', t: { 'hub.day_track': 104 } },
		{ d: '2026-11-11', t: { 'hub.day_track': 110 } }
	];
	it('compares with the newest snapshot at least 6 days old', () => {
		expect(weekGrowth('hub.day_track', 115, hist, '2026-11-12')).toEqual({ pct: 10.6, base: '2026-11-05' });
		expect(weekGrowth('hub.day_track', 115, hist, '2026-11-08')).toEqual({ pct: null, base: null }); // nothing a week old yet
		expect(weekGrowth('spotify_plays', 1, hist, '2026-11-12')).toEqual({ pct: null, base: null });
	});
	it('warns above 10% a week or 20% dead tuples', () => {
		expect(tableTone(5, 9.9)).toBe('ok');
		expect(tableTone(5, 10.1)).toBe('warn');
		expect(tableTone(25, null)).toBe('warn');
		expect(tableTone(null, null)).toBe('ok');
	});
});

describe('v0.92 Server-Timing', () => {
	it('adds up db and spotify time per request', async () => {
		const { t, result } = withTimings(async () => {
			record('db', 12.34);
			record('db', 3);
			record('spotify', 250);
			return 1;
		});
		await result;
		const h = serverTiming(t);
		expect(h).toMatch(/^db;dur=15\.3;desc="2 queries", spotify;dur=250;desc="1 calls", total;dur=[\d.]+$/);
	});
	it('outside a request nothing is recorded (no crash)', () => {
		expect(() => record('db', 1)).not.toThrow();
	});
});
