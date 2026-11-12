/**
 * v0.92: speed + bloat. SWR cache (instant revisit, refresh in place, reset on deploy), optimistic
 * player with rollback, reopen where you left it, and the diff-merge rollups (0035).
 */
import { test, expect, mock, sql, sqlNum } from './fixtures';

const CTL = process.env.E2E_CTL ?? 'http://127.0.0.1:55434';
const clientNav = (page: import('@playwright/test').Page, href: string) =>
	page.evaluate((h) => {
		const a = document.createElement('a');
		a.href = h;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}, href);

test.describe('v0.92 instant revisits (SWR cache)', () => {
	test.use({ serviceWorkers: 'block' }); // so page.route sees the data requests

	test('V092-1 a revisited tab shows cached data at once, then the network answer replaces it in place @both', async ({ page }) => {
		await page.goto('/home');
		await expect(page.locator('section.hero').first()).toBeVisible();
		await clientNav(page, '/stats');
		await expect(page.getByRole('heading', { name: 'Monthly plays' })).toBeVisible();
		await clientNav(page, '/home');
		await expect(page.locator('section.hero').first()).toBeVisible();
		// The network is now slow: the revisit must not wait for it.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		await page.route('**/api/stats/overview', async (r) => {
			await gate;
			const res = await r.fetch();
			const body = await res.json();
			body.totals.plays = 987654321; // a value the cached copy can't have
			await r.fulfill({ response: res, json: body });
		});
		const t0 = Date.now();
		await clientNav(page, '/stats');
		await expect(page.getByRole('heading', { name: 'Monthly plays' })).toBeVisible();
		const ms = Date.now() - t0;
		expect(ms, 'revisit served from the cache').toBeLessThan(600);
		await expect(page.getByText('987,654,321')).toHaveCount(0);
		release();
		await expect(page.getByText('987,654,321').first()).toBeVisible(); // refreshed in place, no reload
	});

	test('V092-2 a deploy never serves an older build’s cached shapes (per-build IndexedDB, old ones deleted) @laptop', async ({ page }) => {
		await page.goto('/stats');
		await expect(page.getByRole('heading', { name: 'Monthly plays' })).toBeVisible();
		const before = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('rotor-swr-')));
		expect(before).toHaveLength(1);
		// Plant a wrong-shaped answer in this build's cache: after the deploy it must never be used.
		await page.evaluate(async (name) => {
			await new Promise<void>((ok) => {
				const req = indexedDB.open(name!, 1);
				req.onsuccess = () => {
					const tx = req.result.transaction('api', 'readwrite');
					tx.objectStore('api').put({ json: '{"bogus":true}', at: Date.now() }, '/api/stats/overview');
					tx.oncomplete = () => (req.result.close(), ok());
				};
			});
		}, before[0]);
		expect((await fetch(`${CTL}/redeploy`, { method: 'POST' })).status).toBe(200);
		await page.goto('/home');
		await expect(page.locator('section.hero').first()).toBeVisible();
		await expect
			.poll(async () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('rotor-swr-'))))
			.not.toContain(before[0]);
		await clientNav(page, '/stats');
		await expect(page.getByRole('heading', { name: 'Monthly plays' })).toBeVisible(); // the real shape, not {"bogus":true}
	});
});

test.describe('v0.92 optimistic player', () => {
	test('V092-3 Pause flips at once; when Spotify refuses it rolls back with a toast @laptop', async ({ page }) => {
		// Remote control of the iPhone (not "This laptop", whose SDK path never calls the API).
		const st = await mock.state();
		st.playback.is_playing = true;
		st.playback.device_id = 'dev-iphone';
		for (const d of st.devices) d.is_active = d.id === 'dev-iphone';
		await mock.set({ playback: st.playback, devices: st.devices });
		await page.addInitScript(() => localStorage.setItem('rotor.sdk', 'off'));
		await page.goto('/home');
		const bar = page.locator('.playerbar, [aria-label="Player"]').first();
		const btn = page.getByRole('button', { name: 'Pause', exact: true }).filter({ visible: true }).first();
		await expect(page.getByRole('button', { name: 'Pause', exact: true }).filter({ visible: true }).first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'Play', exact: true }).filter({ visible: true })).toHaveCount(0);
		await mock.resetCalls();
		await mock.set({ failNext: { path: '/me/player/pause', status: 502, count: 5 } });
		// Recorded inside the page: the label sequence of the tapped button (the flip and the rollback can both
		// happen within one test-runner poll when the mock answers instantly).
		const seq = await page.evaluate(
			() =>
				new Promise<{ label: string; ms: number }[]>((ok) => {
					const b = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Pause"]')].find((x) => x.offsetParent !== null)!;
					const out: { label: string; ms: number }[] = [];
					const t0 = performance.now();
					new MutationObserver(() => out.push({ label: b.getAttribute('aria-label') ?? '', ms: Math.round(performance.now() - t0) })).observe(b, { attributes: true, attributeFilter: ['aria-label'] });
					b.click();
					setTimeout(() => ok(out), 2500);
				})
		);
		expect(seq[0]?.label).toBe('Play'); // flipped on the tap
		expect(seq[0]!.ms).toBeLessThan(50);
		expect((await mock.calls()).some((c) => c.path === '/v1/me/player/pause' && c.status === 502)).toBe(true);
		// Rolled back (the button may be a new element by then, so look it up again).
		await expect(page.locator('[role=status], .toast').filter({ hasText: /Spotify|wrong|refused/i }).first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'Pause', exact: true }).filter({ visible: true }).first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'Play', exact: true }).filter({ visible: true })).toHaveCount(0);
		await mock.set({ failNext: null });
		void bar;
	});
});

test.describe('v0.92 reopen where you left it', () => {
	test('V092-4 the installed app reopens on the last page and scroll position @mobile', async ({ page, context }) => {
		await context.addInitScript(() => {
			const mm = window.matchMedia.bind(window);
			window.matchMedia = (q: string) => (q.includes('display-mode: standalone') ? ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList) : mm(q));
		});
		await page.goto('/stats/top');
		await expect(page.getByRole('heading', { name: /Top 50 tracks/ })).toBeVisible();
		await page.evaluate(() => (document.getElementById('main')!.scrollTop = 900));
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await page.evaluate(() => dispatchEvent(new Event('pagehide')));
		const saved = await page.evaluate(() => localStorage.getItem('rotor.resume'));
		expect(JSON.parse(saved!)).toMatchObject({ path: '/stats/top' });
		// "Reopen": a fresh navigation to the start URL.
		await page.goto('/home');
		await expect(page).toHaveURL(/\/stats\/top$/);
		await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('main')!.scrollTop))).toBeGreaterThan(600);
	});
});

test.describe('v0.92 rollups without bloat (0035)', () => {
	test('V092-5 three full rebuilds write nothing and the day tables keep their size; Data health shows dead tuples @laptop', async ({ page }) => {
		const sizes = () => sql(`SELECT string_agg(pg_total_relation_size(t::regclass)::text, ',' ORDER BY t) FROM unnest(ARRAY['hub.day_track','hub.daily_listening','hub.behaviour_daily']) t`);
		sql(`SELECT hub.refresh_rollups(true)`);
		const s0 = sizes();
		for (let i = 0; i < 3; i++) {
			const r = JSON.parse(sql(`SELECT hub.refresh_rollups(true)::text`));
			for (const t of ['daily_listening', 'day_track', 'behaviour_daily']) {
				expect(r.merge[t].deleted + r.merge[t].updated + r.merge[t].inserted, `${t} run ${i + 1}`).toBe(0);
			}
		}
		expect(sizes()).toBe(s0);
		expect(sqlNum(`SELECT jsonb_array_length(detail -> 'sizes') FROM hub.rollup_state`)).toBeGreaterThanOrEqual(1);
		await page.goto('/settings/health');
		const table = page.getByTestId('health-tables');
		await expect(table).toBeVisible();
		await expect(table.locator('tr[data-table="hub.day_track"], tr[data-table="spotify_plays"]').first()).toBeVisible();
		await expect(page.getByTestId('health-growth-warn')).toHaveCount(0);
	});
});
