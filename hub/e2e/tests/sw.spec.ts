/**
 * Service worker (R2 rules, kept in every release): navigations reach the network, caches are
 * per build, a new deploy never leaves the app on an old shell, offline shows a usable page.
 */
import { test, expect } from './fixtures';

const CTL = process.env.E2E_CTL ?? 'http://127.0.0.1:55434';

async function swReady(page: import('@playwright/test').Page) {
	await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 20_000 });
	if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
	await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
}
const cacheNames = (page: import('@playwright/test').Page) => page.evaluate(() => caches.keys());
const version = (page: import('@playwright/test').Page) => page.evaluate(async () => (await (await fetch('/_app/version.json', { cache: 'no-store' })).json()).version as string);

test.describe('SW', () => {
	test('SW-1 SW-controlled navigations reach the network (not the offline fallback) @both', async ({ page }) => {
		await page.goto('/home');
		await swReady(page);
		for (const p of ['/library', '/stats', '/settings', '/search', '/rules']) {
			await page.goto(p);
			await expect(page.getByText("You're offline")).toHaveCount(0);
			await expect(page.locator('h1').first()).toBeVisible();
		}
	});

	test('SW-2 every cache is named after this build; nothing else is kept @laptop', async ({ page }) => {
		await page.goto('/home');
		await swReady(page);
		const v = await version(page);
		const names = await cacheNames(page);
		expect(names.length).toBeGreaterThan(0);
		for (const n of names) expect(n).toMatch(new RegExp(`^rotor-(shell|pages|data)-${v}$`));
	});

	test('SW-3 a new deploy: the app loads cleanly on the new build, old caches are gone @laptop', async ({ page, errors }) => {
		test.setTimeout(180_000);
		await page.goto('/home');
		await swReady(page);
		const v1 = await version(page);
		expect((await cacheNames(page)).some((n) => n.endsWith(v1))).toBe(true);

		const r = await fetch(`${CTL}/redeploy`, { method: 'POST' });
		expect(r.ok).toBe(true);

		// The open (old) page navigates client-side: SvelteKit notices the new version and reloads.
		await page.locator('a[href="/stats"]').first().click();
		await expect(page.locator('h1').first()).toBeVisible();
		await page.reload();
		await page.waitForFunction(async (old) => (await (await fetch('/_app/version.json', { cache: 'no-store' })).json()).version !== old, v1);
		const v2 = await version(page);
		expect(v2).not.toBe(v1);
		// The new worker takes over and drops every cache of the old build.
		await expect.poll(async () => (await cacheNames(page)).filter((n) => n.endsWith(v1)), { timeout: 30_000 }).toEqual([]);
		await expect.poll(async () => (await cacheNames(page)).some((n) => n.endsWith(v2)), { timeout: 30_000 }).toBe(true);
		await page.goto('/home');
		await expect(page.getByText(/Today's pick · \d+ of \d+/)).toBeVisible();
		await page.goto('/library');
		await expect(page.locator('h1').first()).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('SW-4 offline: cached Home opens, other pages show the offline page, nothing hangs @mobile', async ({ page, context }) => {
		await page.goto('/home');
		await swReady(page);
		await page.goto('/home'); // stored as the offline copy by this build's worker
		await context.setOffline(true);
		try {
			await page.goto('/home');
			await expect(page.getByText(/Today's pick · \d+ of \d+/)).toBeVisible();
			await page.goto('/library');
			await expect(page.getByText("You're offline")).toBeVisible();
		} finally {
			await context.setOffline(false);
		}
		await page.goto('/library');
		await expect(page.getByText("You're offline")).toHaveCount(0);
	});
});
