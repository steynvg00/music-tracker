/** R8: parity gaps — Data health, phantom plays, "This week" digest, skeletons without layout shift. */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const thisYear = () => new Date().getFullYear();

/** The real send_digest (dry-run mail) + rank snapshots, once per run. */
function ensureDigest(): { playlistId: string; top: string; other: string; uris: string[] } {
	const out = execFileSync('uv', ['run', '--no-sync', 'python', 'hub/e2e/digest_fixture.py'], { cwd: REPO, encoding: 'utf8', env: { ...process.env } });
	const line = out.split('\n').find((l) => l.startsWith('FIXTURE '));
	if (!line) throw new Error(`digest_fixture printed no fixture:\n${out.slice(-2000)}`);
	return JSON.parse(line.slice(8));
}

/** Phantom plays around two identified plays (Streamlit's population: no uri, artist or title). */
function seedPhantoms(): { before: string; after: string } {
	// 2015: before anything the seed writes, so the identified neighbours are the two rows below.
	sql(`DELETE FROM spotify_plays WHERE (track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL) OR played_at < '2016-01-01'`);
	const [before, after] = sql(
		`SELECT string_agg(track_uri, ',') FROM (SELECT track_uri FROM hub.mv_track_stats ORDER BY plays DESC, track_uri LIMIT 2) x`
	).split(',') as [string, string];
	sql(`INSERT INTO spotify_plays (played_at, ms_played, platform, track_uri, track_name, artist_name, reason_end) VALUES
		('2015-06-13 20:00:00+00', 200000, 'iOS 17.1 (iPhone15,2)', '${before}', (SELECT track_name FROM hub.mv_track_stats WHERE track_uri = '${before}'), 'E2E', 'trackdone'),
		('2015-06-13 20:04:00+00', 180000, 'iOS 17.1 (iPhone15,2)', NULL, NULL, NULL, 'trackdone'),
		('2015-06-13 20:08:00+00', 30000, 'iOS 17.1 (iPhone15,2)', NULL, NULL, NULL, 'fwdbtn'),
		('2015-06-13 20:12:00+00', 210000, 'iOS 17.1 (iPhone15,2)', '${after}', (SELECT track_name FROM hub.mv_track_stats WHERE track_uri = '${after}'), 'E2E', 'trackdone'),
		('2015-03-02 08:00:00+00', 90000, 'OS X 14.1.0 [x86 8]', NULL, NULL, NULL, NULL)`);
	// A podcast episode also has no track fields: Streamlit counts it, so Rotor does too.
	sql(`INSERT INTO spotify_plays (played_at, ms_played, platform, episode_uri, episode_name, show_name, reason_end)
		VALUES ('2015-07-01 07:30:00+00', 1200000, 'Android OS 13 API 33', 'spotify:episode:e2e0000000000000000001', 'E2E Episode', 'E2E Show', 'endplay')`);
	return { before, after };
}

/** CLS of the page's first load (no input), after it has settled. */
async function settledCls(page: Page, path: string, ready: (p: Page) => Promise<void>): Promise<number> {
	await page.addInitScript(() => {
		const w = window as unknown as { __cls: number; __shifts: string[]; __clsOn?: boolean };
		if (w.__clsOn) return; // addInitScript accumulates per call: observe once per document
		w.__clsOn = true;
		w.__cls = 0;
		w.__shifts = [];
		type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] };
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as Shift[]) {
				if (e.hadRecentInput) continue;
				w.__cls += e.value;
				const src = (e.sources ?? []).map((s) => {
					const el = s.node as Element | undefined;
					const name = el ? `${el.nodeName.toLowerCase()}${el instanceof Element && el.className ? '.' + String(el.className).split(' ')[0] : ''}` : '?';
					return `${name} y${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`;
				});
				w.__shifts.push(`${e.value.toFixed(4)} @${Math.round(e.startTime)}ms ${src.join(', ')}`);
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
	await page.goto(path);
	await ready(page);
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(1200); // late fill-ins: player state, device strip, library list
	const r = await page.evaluate(() => {
		const w = window as unknown as { __cls: number; __shifts: string[] };
		return { cls: w.__cls, shifts: w.__shifts };
	});
	if (r.cls > 0.005) console.log(`[cls] ${path}: ${r.shifts.join(' | ')}`);
	return r.cls;
}

test.describe('R8 Data health', () => {
	test('R8-1 a refused GitHub token → cron health "unknown" with the reason; the rest still renders @laptop', async ({ page }) => {
		await mock.set({ github: { status: 401 } });
		try {
			await page.goto('/settings/health?fresh=1');
			await expect(page.getByTestId('cron-unknown')).toContainText('GitHub refused the token (401)');
			await expect(page.locator('[data-testid=health-cron] li')).toHaveCount(4);
			await expect(page.locator('[data-testid=health-cron] li').first()).toContainText('auto-disable unknown');
			await expect(page.getByTestId('health-ingest')).toContainText('Spotify recently played');
		} finally {
			await mock.set({ github: null });
		}
	});

	test('R8-2 Data health: every source, cron auto-disable dates, enrichment, rollups, DB size, tokens, radar, phantom, digest @laptop', async ({ page }) => {
		await mock.resetCalls();
		const pushedDaysAgo = 40;
		await mock.set({ github: { pushedAt: new Date(Date.now() - pushedDaysAgo * 86_400_000).toISOString(), states: { 'ingest-monitor.yml': 'disabled_inactivity' } } });
		try {
			await page.goto('/settings');
			await page.getByTestId('open-health').click();
			await expect(page).toHaveURL(/\/settings\/health$/);
			await page.getByTestId('health-refresh').click(); // skip the 5-minute cache
			await expect(page.getByTestId('cron-autodisable')).toBeVisible();
			// Last good keepalive (5 days ago) is newer than the last push (40 days): +60 days from it.
			const expected = new Date(Date.now() - 5 * 86_400_000 + 60 * 86_400_000);
			const label = expected.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Amsterdam' });
			await expect(page.getByTestId('cron-autodisable')).toContainText(label);
			await expect(page.getByTestId('cron-autodisable')).toContainText(/\((54|55) days\)/);
			const mon = page.locator('[data-testid=health-cron] li[data-file="ingest-monitor.yml"]');
			await expect(mon).toHaveAttribute('data-tone', 'danger');
			await expect(mon).toContainText('disabled (60 days without activity)');
			await expect(page.locator('[data-testid=health-cron] li[data-file="scheduled-ingest.yml"]')).toContainText(`auto-disable ≈ ${label}`);
			// GitHub was only read, and only api.github.com with the dispatch token.
			const gh = (await mock.calls()).filter((c) => c.host === 'api.github.com');
			expect(gh.length).toBeGreaterThanOrEqual(6);
			expect(gh.every((c) => c.method === 'GET')).toBe(true);

			for (const k of ['recent', 'liked', 'mirror', 'picks', 'metadata', 'track_pop', 'artist_pop', 'radar', 'badges', 'lastfm']) {
				await expect(page.locator(`[data-testid=health-ingest] li[data-key="${k}"]`)).toHaveCount(1);
			}
			const tracks = sqlNum(`SELECT count(*) FROM hub.mv_track_stats`);
			const enriched = sqlNum(`SELECT count(*) FROM hub.mv_track_stats ts JOIN track_metadata tm USING (track_uri)`);
			expect(tracks).toBeGreaterThan(0);
			const en = page.getByTestId('health-enrichment');
			await expect(en).toContainText(`${Math.round((enriched / tracks) * 1000) / 10}%`);
			await expect(en).toContainText('Audio features');
			await expect(en).toContainText('not collected');
			await expect(page.getByTestId('health-rollups')).toContainText('Refreshed');
			const mb = sqlNum(`SELECT pg_database_size(current_database())`) / 1024 / 1024;
			await expect(page.getByTestId('health-db')).toContainText('of 500.0 MB');
			const shown = Number(/([\d.]+) MB of/.exec((await page.getByTestId('health-db').textContent()) ?? '')?.[1]);
			expect(Math.abs(shown - mb)).toBeLessThan(2); // the DB grows a little while tests run
			await expect(page.locator('[data-testid=health-tokens] li[data-client=hub]')).toContainText('stops ≈');
			await expect(page.locator('[data-testid=health-tokens] li')).toHaveCount(2);
			await expect(page.locator('[data-testid=health-radar] li')).toHaveCount(3);
			await expect(page.getByTestId('health-phantom')).toBeVisible();
			await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		} finally {
			await mock.set({ github: null });
		}
	});
});

test.describe('R8 Phantom plays', () => {
	// The phantoms are removed again afterwards: later specs (R3 parity) count every play.
	test.afterEach(() => {
		sql(`DELETE FROM spotify_plays WHERE (track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL) OR played_at < '2016-01-01'`);
	});
	test('R8-3 same population and counts as Streamlit, with breakdowns and links to the tracks around each play @both', async ({ page }) => {
		const { before, after } = seedPhantoms();
		const total = sqlNum(`SELECT count(*) FROM spotify_plays WHERE track_uri IS NULL AND artist_name IS NULL AND track_name IS NULL`);
		expect(total).toBe(4);
		await page.goto('/settings/health');
		await expect(page.getByTestId('health-phantom')).toContainText('4 plays');
		await page.getByRole('link', { name: 'See all' }).first().click();
		await expect(page).toHaveURL(/\/settings\/health\/phantom/);
		await expect(page.getByTestId('phantom-total')).toHaveText('4');
		await expect(page.getByTestId('phantom-summary')).toContainText('1 podcast/audiobook');
		await expect(page.getByTestId('phantom-summary')).toContainText('2015-03-02');
		await expect(page.getByTestId('phantom-summary')).toContainText('2015-07-01');
		await expect(page.getByRole('list', { name: 'Phantom plays by platform' })).toContainText('iOS 17.1 (iPhone15,2)');
		await expect(page.getByRole('list', { name: 'Phantom plays by end reason' })).toContainText('(null)');
		const rows = page.locator('[data-testid=phantom-list] li');
		await expect(rows).toHaveCount(4);
		await expect(rows.first()).toContainText('E2E Episode');
		// The two January phantoms sit between the seeded plays: both neighbours link to track pages.
		const jan = rows.filter({ hasText: 'fwdbtn' });
		await expect(jan.locator(`a[href="/track/${encodeURIComponent(before)}"]`)).toBeVisible();
		await expect(jan.locator(`a[href="/track/${encodeURIComponent(after)}"]`)).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	});
});

test.describe('R8 This week', () => {
	test('R8-4 the Monday digest in-app: stored by the real send_digest, sections and rank arrows as in the mail @both', async ({ page }) => {
		const f = ensureDigest();
		expect(sql(`SELECT run_type || ':' || delivery_status FROM digest_runs ORDER BY id DESC LIMIT 1`)).toBe('weekly:push_sent');
		await page.goto('/home'); // v0.91: "This week" moved from the Library to Home
		await page.getByRole('link', { name: 'This week' }).click();
		await expect(page).toHaveURL(/\/digest$/);
		await expect(page.getByTestId('digest-last')).toContainText('3 changed');
		await expect(page.getByTestId('digest-summary')).toHaveText('1 playlist created, 2 updated.');
		const top = page.locator(`article[data-name="${f.top}"]`);
		await expect(top).toHaveAttribute('data-section', 'updated');
		const arrows = await top.locator('.ar').allTextContents();
		// Last week: c=1, a=2, b=3. Now: a=1, b=2, c=3, d new.
		expect(arrows).toEqual(['↑ 1', '↑ 1', '↓ 2', '★ NEW']);
		await expect(top.locator('li').first()).toContainText('20 plays');
		await expect(top.locator('li a').first()).toHaveAttribute('href', `/track/${encodeURIComponent(f.uris[0]!)}`);
		const other = page.locator(`article[data-name="${f.other}"]`);
		await expect(other).toContainText('+1 added, −1 removed');
		await expect(page.locator('article[data-name="E2E Brand new · Auto 🤖🔄"]')).toContainText('2 tracks added at creation.');
		await expect(page.locator('[data-testid=digest-run]')).toContainText('pushed');
	});

	test('R8-5 browsable per week: last week is rebuilt from rank history with the same arrows @laptop', async ({ page }) => {
		const f = ensureDigest();
		await page.goto('/digest');
		const wk = await page.getByTestId('digest-week').textContent();
		await page.getByTestId('digest-older').click();
		await expect(page).toHaveURL(/\/digest\?week=\d{4}-\d{2}-\d{2}$/);
		await expect(page.getByTestId('digest-week')).not.toHaveText(wk ?? '');
		await expect(page.getByTestId('digest-rebuilt')).toBeVisible();
		const top = page.locator(`article[data-name="${f.top}"]`);
		// Two weeks ago: a=1, b=2, c=3. Last week: c=1, a=2, b=3.
		expect(await top.locator('.ar').allTextContents()).toEqual(['↑ 2', '↓ 1', '↓ 1']);
		await page.getByTestId('digest-newer').click();
		await expect(page.getByTestId('digest-week')).toHaveText(wk ?? '');
		// The week picker lists both weeks.
		expect(await page.locator('#wk option').count()).toBeGreaterThanOrEqual(2);
	});
});

test.describe('R8 Skeletons', () => {
	test('R8-6 no layout shift on first load: Home, Stats, Library, Wrapped, Release radar (CLS < 0.02) @both', async ({ page }, info) => {
		const results: Record<string, number> = {};
		results.home = await settledCls(page, '/home', async (p) => {
			await expect(p.locator('section.hero').first()).toBeVisible();
		});
		results.stats = await settledCls(page, '/stats', async (p) => {
			await expect(p.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();
		});
		results.library = await settledCls(page, '/library', async (p) => {
			await expect(p.locator('.list a, .list button').first()).toBeVisible();
		});
		results.wrapped = await settledCls(page, `/wrapped/${thisYear()}`, async (p) => {
			await expect(p.getByRole('dialog').or(p.getByRole('heading', { level: 1 })).first()).toBeVisible();
		});
		results.radar = await settledCls(page, '/radar', async (p) => {
			await expect(p.getByRole('heading', { name: 'Release radar', level: 1 })).toBeVisible();
		});
		console.log(`[perf] CLS ${info.project.name} ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Math.round(v * 10000) / 10000])))}`);
		for (const [k, v] of Object.entries(results)) expect(v, `CLS on ${k}`).toBeLessThan(0.02);
	});

	test.describe('during client navigation', () => {
		test.use({ serviceWorkers: 'block' }); // so page.route sees the data requests
		test('R8-7 a slow page shows its skeleton (header in place), then the content; fast ones never flash @laptop', async ({ page }) => {
			const slow = async (pattern: string, ms: number) =>
				page.route(pattern, async (r) => {
					await new Promise((res) => setTimeout(res, ms));
					await r.continue();
				});
			await slow('**/api/stats/overview', 1500);
			await slow('**/api/radar', 1500);
			await page.goto('/home');
			await expect(page.locator('section.hero').first()).toBeVisible();
			await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: 'Stats', exact: true }).click();
			const sk = page.locator('[data-testid=skeleton][data-kind=stats]');
			await expect(sk).toBeVisible();
			await expect(sk.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();
			await expect(sk).toHaveAttribute('aria-busy', 'true');
			await expect(page.locator('[data-testid=skeleton]')).toHaveCount(0, { timeout: 10_000 });
			await expect(page).toHaveURL(/\/stats$/);
			await page.goto('/home'); // v0.91: "Release radar" moved from the Library to Home
			await page.getByTestId('home-radar').click();
			await expect(page.locator('[data-testid=skeleton][data-kind=radar]')).toBeVisible();
			await expect(page.locator('[data-testid=skeleton]')).toHaveCount(0, { timeout: 10_000 });
			// A fast navigation (no delay) never shows a skeleton.
			let flashed = false;
			await page.exposeFunction('__sawSkeleton', () => (flashed = true));
			await page.evaluate(() => {
				new MutationObserver(() => document.querySelector('[data-testid=skeleton][data-kind=library]') && (window as unknown as { __sawSkeleton: () => void }).__sawSkeleton()).observe(document.body, { childList: true, subtree: true });
			});
			await page.getByRole('complementary', { name: 'Navigation' }).locator('a.navlink[href="/library"]').click();
			await expect(page).toHaveURL(/\/library$/);
			await page.waitForTimeout(400);
			expect(flashed).toBe(false);
		});

		test('R8-8 Library shows skeleton rows from the first paint until the list arrives (no "Nothing here" flash) @mobile', async ({ page }) => {
			await page.route('**/api/playlists', async (r) => {
				await new Promise((res) => setTimeout(res, 1500));
				await r.continue();
			});
			await page.goto('/library');
			await expect(page.locator('[data-testid=skeleton]')).toBeVisible();
			await expect(page.getByText('Nothing here with these filters.')).toHaveCount(0);
			await expect(page.locator('[data-testid=skeleton]')).toHaveCount(0, { timeout: 10_000 });
			await expect(page.locator('.list').first()).toBeVisible();
		});
	});
});
