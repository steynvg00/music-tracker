import { describe, expect, it } from 'vitest';
import { fakeSql } from '$lib/server/test-helpers';
import { streaksFrom, topTracks } from './core';
import { milestones, periodBounds } from './sections';
import { likePattern } from './detail';
import { hash, isRollupsMissing, statsResponse } from './http';
import { loadHomeStats } from '$lib/server/home';
import { parseRange } from '$lib/shared/stats';

describe('streaksFrom (Streamlit gaps-and-islands)', () => {
	it('current = the run ending today or yesterday; longest = max run', () => {
		const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-11-02', '2026-11-03', '2026-11-04'];
		expect(streaksFrom(days, '2026-11-05')).toEqual({ current: 3, longest: 3 });
		expect(streaksFrom(days, '2026-11-04')).toEqual({ current: 3, longest: 3 });
		expect(streaksFrom(days, '2026-11-06')).toEqual({ current: 0, longest: 3 });
		expect(streaksFrom([], '2026-11-06')).toEqual({ current: 0, longest: 0 });
	});
});

describe('milestones', () => {
	it('finds the day from cumulative sums and offsets into it', async () => {
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('sum(plays) OVER')) {
				return [
					{ d: new Date('2020-01-01'), before: '0', plays: 600 },
					{ d: new Date('2020-01-02'), before: '600', plays: 600 }
				];
			}
			if (q.text.includes('OFFSET')) return [{ played_at: new Date('2020-01-02T10:00:00Z'), artist: 'A', track: 'T' }];
			return [];
		});
		const m = await milestones(sql);
		expect(m.map((x) => x.n)).toEqual([1, 1000]);
		const offsets = queries.filter((q) => q.text.includes('OFFSET')).map((q) => q.values.at(-1));
		expect(offsets).toEqual([0, 399]); // 1st play = offset 0 on day 1; 1000th = 400th play of day 2
	});
});

describe('periodBounds', () => {
	it('covers whole years and months, rejects junk', () => {
		expect(periodBounds('year', '2024')).toEqual({ start: '2024-01-01', end: '2024-12-31' });
		expect(periodBounds('month', '2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
		expect(periodBounds('month', '2024-13')).toBeNull();
		expect(periodBounds('year', '24')).toBeNull();
	});
});

describe('topTracks', () => {
	it('plays ranking passes the Streamlit date bounds as parameters (no string SQL)', async () => {
		const { sql, queries } = fakeSql(() => [{ uri: 'spotify:track:0000000000000000000001', plays: 9, name: 'X', artist: 'Y', artist_id: null }]);
		const rows = await topTracks(sql, parseRange('year-2024', '2026-11-05'), 'plays');
		expect(rows[0]).toMatchObject({ rank: 1, plays: 9, name: 'X' });
		expect(queries[0]!.text).toContain('canonical_track_uri');
		expect(queries[0]!.values).toContain('2024-01-01');
		expect(queries[0]!.values).toContain('2024-12-31');
	});
	it('score rankings select the column through a CASE on a bound parameter', async () => {
		const { sql, queries } = fakeSql(() => []);
		await topTracks(sql, parseRange('all', '2026-11-05'), 'sticky');
		expect(queries[0]!.text).toContain('track_popularity_scores');
		expect(queries[0]!.values).toContain('sticky_pct');
	});
});

describe('stats http', () => {
	it('likePattern escapes wildcards', () => {
		expect(likePattern(' 50%_off\\ ')).toBe('%50\\%\\_off\\\\%');
	});
	it('answers 304 when the ETag still matches the rollup refresh', async () => {
		const { sql } = fakeSql((q) => (q.text.includes('rollup_state') ? [{ refreshed_at: new Date('2026-11-05T10:00:00Z') }] : []));
		let computed = 0;
		const first = await statsResponse(sql, new Request('http://x/api/stats/overview'), 'k', async () => (computed++, { ok: 1 }));
		expect(first.status).toBe(200);
		expect(first.headers.get('cache-control')).toBe('private, max-age=30');
		const etag = first.headers.get('etag')!;
		const again = await statsResponse(sql, new Request('http://x/api/stats/overview', { headers: { 'if-none-match': etag } }), 'k', async () => (computed++, { ok: 1 }));
		expect(again.status).toBe(304);
		expect(computed).toBe(1);
		expect(hash('a')).not.toBe(hash('b'));
	});
	it('a missing migration 0023 becomes a 503 rollups_missing, and Home stats become null', async () => {
		const missing = Object.assign(new Error('relation "hub.rollup_state" does not exist'), { code: '42P01' });
		const { sql } = fakeSql(() => {
			throw missing;
		});
		expect(isRollupsMissing(missing)).toBe(true);
		const res = await statsResponse(sql, new Request('http://x/api/stats/overview'), 'k', async () => ({}));
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toBe('rollups_missing');
		const noFn = Object.assign(new Error('function hub.home_payload(date) does not exist'), { code: '42883' });
		const { sql: sql2 } = fakeSql(() => {
			throw noFn;
		});
		await expect(loadHomeStats(sql2, '2026-11-05')).resolves.toBeNull();
	});
	it('other database errors are not swallowed by loadHomeStats', async () => {
		const { sql } = fakeSql(() => {
			throw Object.assign(new Error('boom'), { code: '57014' });
		});
		await expect(loadHomeStats(sql, '2026-11-05')).rejects.toThrow('boom');
	});
});
