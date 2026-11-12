/**
 * v0.92 speed measurements (the PR's before/after tables). Runs only with E2E_PERF=1, best with the
 * production-sized seed and realistic Spotify latency:
 *
 *   E2E_PERF=1 E2E_SCALE=prod E2E_SPOTIFY_LATENCY_MS=250 E2E_PERF_LABEL=before E2E_GREP=PERF npm run e2e
 *
 * iPhone project: Fast 4G (DevTools preset: 9 Mbps down, 1.5 Mbps up, 165 ms RTT) via CDP.
 * Laptop project: no throttling. Writes e2e/.out/perf-<label>-<project>.json.
 *   cold  = a new browser context (no service worker, no HTTP cache) → content visible
 *   warm  = client navigation from Home → content visible (1st visit, then a revisit)
 *   api   = Server-Timing of every /api response seen (median total / db / spotify, ms)
 *   play / skip = tap → the UI shows the new state
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, mock, guardExternal } from './fixtures';

const OUT = process.env.E2E_OUT ?? 'e2e/.out';
const LABEL = process.env.E2E_PERF_LABEL ?? 'run';
const RUNS = Number(process.env.E2E_PERF_RUNS ?? 3);

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]!) : NaN;
};

interface Target {
	key: string;
	path: (f: Record<string, any>) => string;
	ready: (p: Page) => Promise<void>;
}
const TARGETS: Target[] = [
	{ key: 'Home', path: () => '/home', ready: async (p) => void (await p.locator('section.hero').first().waitFor()) },
	{ key: 'Library', path: () => '/library', ready: async (p) => void (await p.locator('[data-testid=entries] [data-testid=entry]').first().waitFor()) },
	{ key: 'Stats', path: () => '/stats', ready: async (p) => void (await p.getByRole('heading', { name: 'Monthly plays' }).waitFor()) },
	{ key: 'Artist', path: (f) => `/artist/${f.artist0.id}`, ready: async (p) => void (await p.locator('h1.ttl').waitFor()) },
	{ key: 'Playlist', path: (f) => `/playlist/${f.top30}`, ready: async (p) => void (await p.locator('main h1[title]').first().waitFor()) },
	{ key: 'Search', path: () => '/search?q=track', ready: async (p) => void (await p.getByRole('heading', { name: 'Tracks', exact: true }).waitFor()) }
];

async function throttle(page: Page, mobile: boolean) {
	if (!mobile) return;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 });
}

function collectTimings(page: Page, into: Map<string, { total: number[]; db: number[]; spotify: number[] }>) {
	page.on('response', (r) => {
		const u = new URL(r.url());
		const doc = r.request().resourceType() === 'document';
		if (!u.pathname.startsWith('/api/') && !doc) return;
		const st = r.headers()['server-timing'];
		if (!st) return;
		const get = (k: string) => Number((new RegExp(`${k};dur=([\\d.]+)`).exec(st) ?? [])[1] ?? NaN);
		const key = (doc ? 'page ' : '') + u.pathname.replace(/\/[A-Za-z0-9]{22}(?=\/|$)/g, '/:id').replace(/\/spotify%3A[^/]+/g, '/:uri');
		const e = into.get(key) ?? { total: [], db: [], spotify: [] };
		e.total.push(get('total'));
		e.db.push(get('db'));
		e.spotify.push(get('spotify'));
		into.set(key, e);
	});
}

async function freshPage(browser: Browser, storageState: string, use: Record<string, unknown>): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({ ...use, storageState });
	const page = await ctx.newPage();
	await guardExternal(page, []);
	return { ctx, page };
}

test.describe('PERF speed measurements', () => {
	test.skip(!process.env.E2E_PERF, 'perf run only (E2E_PERF=1)');
	test.setTimeout(600_000);

	test('PERF cold start, warm navigation, API timings, play/skip @both', async ({ browser, page }, info) => {
		const mobile = info.project.name === 'mobile';
		const f = await mock.fixture();
		const auth = `${OUT}/auth.json`;
		const use = { ...(info.project.use as Record<string, unknown>) };
		delete use.storageState;
		const api = new Map<string, { total: number[]; db: number[]; spotify: number[] }>();
		const cold: Record<string, number[]> = {};
		const warm1: Record<string, number[]> = {};
		const warm2: Record<string, number[]> = {};

		// Cold: a brand-new context per load (no service worker, no cache, no IndexedDB).
		for (const t of TARGETS) {
			cold[t.key] = [];
			for (let i = 0; i < RUNS; i++) {
				const { ctx, page: p } = await freshPage(browser, auth, use);
				await throttle(p, mobile);
				collectTimings(p, api);
				const t0 = Date.now();
				await p.goto(t.path(f), { waitUntil: 'commit' });
				await t.ready(p);
				cold[t.key]!.push(Date.now() - t0);
				await ctx.close();
			}
		}

		// Warm: one app session; client navigation from Home to each target, twice (1st visit, revisit).
		for (let i = 0; i < RUNS; i++) {
			const { ctx, page: p } = await freshPage(browser, auth, use);
			await throttle(p, mobile);
			collectTimings(p, api);
			await p.goto('/home');
			await TARGETS[0]!.ready(p);
			await p.waitForLoadState('networkidle');
			for (const round of [warm1, warm2]) {
				for (const t of TARGETS.slice(1)) {
					const t0 = Date.now();
					await p.evaluate((href) => {
						const a = document.createElement('a');
						a.href = href;
						a.textContent = 'perf';
						a.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
						document.body.appendChild(a);
						a.click();
						a.remove();
					}, t.path(f));
					await t.ready(p);
					(round[t.key] ??= []).push(Date.now() - t0);
					await p.waitForTimeout(300);
				}
				// back to Home between rounds (measured as a warm Home visit)
				const t0 = Date.now();
				await p.evaluate(() => {
					const a = document.createElement('a');
					a.href = '/home';
					document.body.appendChild(a);
					a.click();
					a.remove();
				});
				await TARGETS[0]!.ready(p);
				(round.Home ??= []).push(Date.now() - t0);
				await p.waitForTimeout(300);
			}
			await ctx.close();
		}

		// Play / Pause / Skip: tap → the button / track reflects it.
		const play: number[] = [];
		const skip: number[] = [];
		await throttle(page, mobile);
		await page.goto('/home');
		await expect(page.getByRole('button', { name: /^(Play|Pause)$/ }).first()).toBeVisible();
		// Timed inside the page: element.click() → a MutationObserver sees the new state (no test-runner polling).
		const tapUntil = (sel: string, attr: string, want: string) =>
			page.evaluate(
				({ sel, attr, want }) =>
					new Promise<number>((ok, ko) => {
						const btn = [...document.querySelectorAll<HTMLElement>(sel)].find((b) => b.offsetParent !== null);
						const watch = [...document.querySelectorAll<HTMLElement>(attr.startsWith('aria-valuetext') ? '[role=slider]' : sel)].find((b) => b.offsetParent !== null);
						if (!btn || !watch) return ko(new Error('no control'));
						const name = attr.split('|')[0]!;
						const re = new RegExp(want);
						const t0 = performance.now();
						const obs = new MutationObserver(() => {
							if (re.test(watch.getAttribute(name) ?? '')) {
								obs.disconnect();
								ok(performance.now() - t0);
							}
						});
						obs.observe(watch, { attributes: true, attributeFilter: [name] });
						btn.click();
						setTimeout(() => (obs.disconnect(), ko(new Error('timeout'))), 10_000);
					}),
				{ sel, attr, want }
			);
		for (let i = 0; i < RUNS * 2; i++) {
			const label = await page.getByRole('button', { name: /^(Play|Pause)$/ }).first().getAttribute('aria-label');
			const want = label === 'Play' ? 'Pause' : 'Play';
			play.push(await tapUntil(`button[aria-label="${label}"]`, 'aria-label', `^${want}$`));
			await page.waitForTimeout(1500);
		}
		if (!mobile) {
			if ((await page.getByRole('button', { name: 'Play', exact: true }).count()) > 0) await page.getByRole('button', { name: 'Play', exact: true }).first().click();
			for (let i = 0; i < RUNS; i++) {
				await page.waitForTimeout(4000);
				skip.push(await tapUntil('button[aria-label="Next"]', 'aria-valuetext|slider', '^0:0[0-2]$'));
			}
		}

		const result = {
			label: LABEL,
			project: info.project.name,
			throttled: mobile ? 'Fast 4G' : 'none',
			cold: Object.fromEntries(Object.entries(cold).map(([k, v]) => [k, median(v)])),
			warmFirst: Object.fromEntries(Object.entries(warm1).map(([k, v]) => [k, median(v)])),
			warmRevisit: Object.fromEntries(Object.entries(warm2).map(([k, v]) => [k, median(v)])),
			playPause: median(play),
			skip: skip.length ? median(skip) : null,
			api: Object.fromEntries([...api].sort().map(([k, v]) => [k, { n: v.total.length, total: median(v.total), db: median(v.db), spotify: median(v.spotify) }]))
		};
		writeFileSync(join(OUT, `perf-${LABEL}-${info.project.name}.json`), JSON.stringify(result, null, 2));
		console.log(`[perf] ${JSON.stringify(result)}`);
	});
});
