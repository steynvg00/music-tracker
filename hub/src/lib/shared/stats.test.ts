import { describe, expect, it } from 'vitest';
import {
	badgeGrid,
	badgeIcon,
	describeBadge,
	diff,
	fillDays,
	fmtScore,
	heatmapGrid,
	ordinal,
	parseRange,
	trackHref,
	artistHref,
	artistIdFromUri,
	TRACK_BADGE_CATEGORIES,
	type BadgeEvent
} from './stats';

describe('parseRange', () => {
	const today = '2026-11-05';
	it('maps the Streamlit time ranges', () => {
		expect(parseRange('all', today)).toMatchObject({ kind: 'all', start: null, end: null });
		expect(parseRange('this_year', today)).toMatchObject({ start: '2026-01-01', end: '2026-12-31' });
		expect(parseRange('last_year', today)).toMatchObject({ start: '2025-01-01', end: '2025-12-31' });
		expect(parseRange('year-2019', today)).toMatchObject({ kind: 'year', start: '2019-01-01', end: '2019-12-31', label: '2019' });
		expect(parseRange('range-2024-01-01_2024-06-30', today)).toMatchObject({ kind: 'range', start: '2024-01-01', end: '2024-06-30' });
	});
	it('falls back to all time on anything invalid', () => {
		for (const k of [null, '', 'year-2099', 'year-12', 'range-2024-02-30_2024-03-01', 'range-2024-06-01_2024-01-01', "'; DROP TABLE x"]) {
			expect(parseRange(k, today).kind).toBe('all');
		}
	});
});

describe('heatmapGrid', () => {
	it('turns Postgres DOW (0 = Sunday) into Monday-first rows', () => {
		const g = heatmapGrid([
			{ dow: 1, hour: 8, plays: 5 },
			{ dow: 0, hour: 23, plays: 2 },
			{ dow: 9, hour: 1, plays: 99 }
		]);
		expect(g).toHaveLength(7);
		expect(g[0]![8]).toBe(5); // Monday
		expect(g[6]![23]).toBe(2); // Sunday last
		expect(g.flat().reduce((a, b) => a + b, 0)).toBe(7); // out-of-range rows ignored
	});
});

describe('fillDays / diff / ordinal / fmtScore', () => {
	it('fills gaps with zero', () => {
		expect(fillDays([{ d: '2026-01-02', plays: 3 }], '2026-01-01', '2026-01-03').map((p) => p.y)).toEqual([0, 3, 0]);
	});
	it('formats differences and ordinals', () => {
		expect(diff(120, 100)).toEqual({ text: '+20 (+20%)', dir: 'up' });
		expect(diff(5, 5).dir).toBe('flat');
		expect(diff(1, 0)).toEqual({ text: '+1', dir: 'up' });
		expect(ordinal(1)).toBe('1st');
		expect(ordinal(1000)).toBe('1,000th');
		expect(ordinal(12)).toBe('12th');
		expect(ordinal(22)).toBe('22nd');
	});
	it('shows scores like Streamlit', () => {
		expect(fmtScore('composite', 0.81234)).toBe('0.812');
		expect(fmtScore('sticky', 0.456)).toBe('46%');
		expect(fmtScore('plays', null)).toBe('');
	});
});

describe('badges', () => {
	const ev = (badgeType: string, awardedAt: string, context: Record<string, unknown> = {}): BadgeEvent => ({
		badgeType,
		entityType: 'track',
		entityId: 'spotify:track:0000000000000000000001',
		awardedAt,
		context
	});
	it('shows every slot, earned ones marked, multi-fire counted, single-fire once', () => {
		const grid = badgeGrid('track', [
			ev('plays_50', '2024-01-01T00:00:00Z'),
			ev('plays_50', '2024-02-01T00:00:00Z'), // a second variant: still one achievement
			ev('top_1st_month', '2024-03-01T00:00:00Z', { window: '2024-03', plays_in_window: 30 }),
			ev('top_1st_month', '2024-05-01T00:00:00Z', { window: '2024-05' })
		]);
		expect(grid.map((c) => c.name)).toEqual(TRACK_BADGE_CATEGORIES.map((c) => c.name));
		const chips = grid.flatMap((c) => c.chips);
		expect(chips).toHaveLength(TRACK_BADGE_CATEGORIES.reduce((a, c) => a + c.types.length, 0));
		expect(chips.find((c) => c.type === 'plays_50')).toMatchObject({ earned: true, count: 1 });
		expect(chips.find((c) => c.type === 'top_1st_month')).toMatchObject({ earned: true, count: 2, details: ['2024-03 · 30 plays', '2024-05'] });
		expect(chips.find((c) => c.type === 'plays_500')).toMatchObject({ earned: false, count: 0 });
	});
	it('describes contexts like _format_badge_context', () => {
		expect(describeBadge('plays_100')).toBe('Reached 100 cumulative plays');
		expect(describeBadge('plays_20_in_day', { plays_that_day: 21, window: '2026-06-04' })).toBe('21 plays on 2026-06-04');
		expect(describeBadge('streak_5_years', { streak_start_year: 2019 })).toBe('5 consecutive years from 2019 to 2023');
		expect(describeBadge('comeback', { plays_that_month: 9, window: '2026-05', dormant_since: '2025-01' })).toBe('9 plays in 2026-05 after 15-month dormancy');
		expect(describeBadge('top_1st_artist_year', { window: '2025', plays: 400 })).toBe('2025 · 400 plays');
		expect(describeBadge('unknown_kind', { a: 1 })).toBe('{"a":1}');
	});
	it('maps icons like lib/badges.BADGE_ICONS', () => {
		expect(badgeIcon('plays_50')).toBe('/badges/50_plays.png');
		expect(badgeIcon('late_bloomer')).toBe('/badges/slow_burn.png');
		expect(badgeIcon('dynasty')).toBeNull();
	});
});

describe('detail links', () => {
	it('only links valid Spotify ids', () => {
		expect(trackHref('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toBe('/track/spotify%3Atrack%3A4uLU6hMCjMI75M1A2tKUQC');
		expect(trackHref('spotify:episode:4uLU6hMCjMI75M1A2tKUQC')).toBeNull();
		expect(artistHref('0OdUWJ0sBjDrqHygGUXeCF')).toBe('/artist/0OdUWJ0sBjDrqHygGUXeCF');
		expect(artistHref('../etc')).toBeNull();
		expect(artistIdFromUri('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF')).toBe('0OdUWJ0sBjDrqHygGUXeCF');
		expect(artistIdFromUri(null)).toBeNull();
	});
});
