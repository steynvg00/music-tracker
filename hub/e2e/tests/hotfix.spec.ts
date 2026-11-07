/**
 * v0.83.1 hotfix: (1) the hub's DB pool never pipelines queries (Supavisor transaction mode),
 * (2) an installed PWA can't get stuck on a black screen after a deploy.
 */
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import postgres from 'postgres';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { createHubPool, poolOptions } from '../../src/lib/server/db/options';

const DB = process.env.E2E_DB ?? '';

/**
 * A TCP proxy in front of the throwaway Postgres that parses the wire protocol and records, per
 * connection, the most queries ever "in flight": sent (Sync / simple Query) but not yet answered
 * with ReadyForQuery. 1 = strictly one at a time; > 1 = pipelined.
 */
async function pipelineProbe(): Promise<{ url: string; maxInFlight: (app?: string) => number; close: () => Promise<void> }> {
	const target = new URL(DB);
	let max = 0;
	const byApp = new Map<string, number>(); // application_name (from the startup message) → max in flight
	const sockets: Socket[] = [];
	const server = createServer((client) => {
		const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
		sockets.push(client, upstream);
		let started = false; // the startup message has no type byte
		let ready = false; // the first ReadyForQuery ends the startup
		let inFlight = 0;
		let app = '';
		let cbuf = Buffer.alloc(0);
		let sbuf = Buffer.alloc(0);
		client.on('data', (chunk) => {
			upstream.write(chunk);
			cbuf = Buffer.concat([cbuf, chunk]);
			for (;;) {
				if (!started) {
					if (cbuf.length < 4) break;
					const len = cbuf.readInt32BE(0);
					if (cbuf.length < len) break;
					const params = cbuf.subarray(8, len).toString('utf8').split('\0');
					const i = params.indexOf('application_name');
					app = i >= 0 ? params[i + 1]! : '';
					cbuf = cbuf.subarray(len);
					started = true;
					continue;
				}
				if (cbuf.length < 5) break;
				const type = String.fromCharCode(cbuf[0]!);
				const len = cbuf.readInt32BE(1);
				if (cbuf.length < 1 + len) break;
				cbuf = cbuf.subarray(1 + len);
				if (ready && (type === 'S' || type === 'Q')) {
					max = Math.max(max, ++inFlight);
					byApp.set(app, Math.max(byApp.get(app) ?? 0, inFlight));
				}
			}
		});
		upstream.on('data', (chunk) => {
			client.write(chunk);
			sbuf = Buffer.concat([sbuf, chunk]);
			for (;;) {
				if (sbuf.length < 5) break;
				const type = String.fromCharCode(sbuf[0]!);
				const len = sbuf.readInt32BE(1);
				if (sbuf.length < 1 + len) break;
				sbuf = sbuf.subarray(1 + len);
				if (type === 'Z') {
					if (!ready) ready = true;
					else inFlight = Math.max(0, inFlight - 1);
				}
			}
		});
		const end = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on('error', end).on('close', end);
		upstream.on('error', end).on('close', end);
	});
	await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
	const port = (server.address() as AddressInfo).port;
	const url = new URL(DB);
	url.port = String(port);
	return {
		url: url.href,
		maxInFlight: (a?: string) => (a === undefined ? max : (byApp.get(a) ?? 0)),
		close: () =>
			new Promise<void>((ok) => {
				for (const s of sockets) s.destroy();
				server.close(() => ok());
			})
	};
}

/**
 * What /api/home does: a Promise.all of mixed queries. postgres.js pipelines the ones whose
 * parameter types it already knows (e.g. parameterless ones like `SELECT max(played_at) …`); with
 * prepare: false a parameterised query is described first, which isn't pipelined.
 */
async function burst(sql: postgres.Sql) {
	await sql`SELECT 1`; // connection up, startup done
	const rs = await Promise.all([
		...Array.from({ length: 6 }, () => sql`SELECT count(*)::int AS n FROM spotify_plays`),
		...Array.from({ length: 4 }, (_, i) => sql`SELECT ${i}::int + count(*)::int AS n FROM spotify_plays WHERE played_at > now() - (${i} || ' days')::interval`),
		sql`SELECT max(played_at) IS NOT NULL AS n FROM spotify_plays`
	]);
	return rs.map((r) => String(r[0]!.n));
}

test.describe('v0.83.1 hotfix', () => {
	test('HF-1 the hub pool sends one query per connection at a time (safe in Supavisor transaction mode) @laptop', async () => {
		// Negative control: postgres.js defaults DO pipeline (so the probe can see it).
		const control = await pipelineProbe();
		const loose = postgres(control.url, { max: 1, prepare: false });
		await burst(loose);
		await loose.end();
		await control.close();
		expect(control.maxInFlight()).toBeGreaterThan(1);

		// The hub's options, squeezed onto ONE connection: never more than one query in flight.
		const probe = await pipelineProbe();
		const hub = postgres(probe.url, { ...poolOptions({ local: true }), max: 1 });
		const one = await burst(hub);
		await hub.end();
		await probe.close();
		expect(probe.maxInFlight()).toBe(1);
		// …and with the real pool size the answers are the same (concurrency comes from the pool).
		const probe2 = await pipelineProbe();
		const pool = postgres(probe2.url, poolOptions({ local: true }));
		expect(await burst(pool)).toEqual(one);
		await pool.end();
		await probe2.close();
		expect(probe2.maxInFlight()).toBe(1);
	});

	test('HF-1b the real hub client: transactions work (max_pipeline 0 alone hangs begin()), autocommit never pipelines @laptop', async () => {
		const probe = await pipelineProbe();
		const sql = createHubPool(probe.url);
		// Transactions run concurrently with an autocommit burst, like rotate + /api/home.
		const txs = Array.from({ length: 4 }, (_, i) =>
			sql.begin(async (tx) => {
				const [a, b] = await Promise.all([tx`SELECT ${i}::int AS v`, tx`SELECT count(*)::int AS n FROM spotify_plays`]);
				return a![0]!.v + (b![0]!.n >= 0 ? 0 : 1);
			})
		);
		const [burstResult, txResults] = await Promise.all([burst(sql), Promise.race([Promise.all(txs), new Promise((_, no) => setTimeout(() => no(new Error('begin() hung')), 10_000))])]);
		expect(txResults).toEqual([0, 1, 2, 3]);
		expect(burstResult).toHaveLength(11);
		await sql.end();
		await probe.close();
		expect(probe.maxInFlight('rotor-hub')).toBe(1); // autocommit pool: strictly one at a time
		expect(probe.maxInFlight('rotor-hub-tx')).toBeGreaterThanOrEqual(1); // transactions did run on their own pool
	});

	// ── PWA: never stuck on a black screen after a deploy ──────────────────────

	const CTL = process.env.E2E_CTL ?? 'http://127.0.0.1:55434';
	const deploy = async (ref: string | null) => {
		const r = await fetch(`${CTL}/deploy${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, { method: 'POST', signal: AbortSignal.timeout(120_000) });
		expect(r.ok, await r.clone().text()).toBe(true);
	};
	const swReady = async (page: Page) => {
		await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 30_000 });
		if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
		await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
	};
	const version = (page: Page) => page.evaluate(async () => (await (await fetch('/_app/version.json', { cache: 'no-store' })).json()).version as string);
	const booted = (page: Page) => page.evaluate(() => (window as unknown as { __rotorBoot?: { isBooted: () => boolean } }).__rotorBoot?.isBooted() ?? false);

	// The three releases that reached production before this fix, each with its own worker.
	for (const ref of ['v0.81-hub-remote-and-daily-pick', 'v0.82-hub-playlists-and-rules', 'v0.83-hub-stats-parity']) {
		test(`HF-2 an installed app on ${ref} comes up on the new build after a deploy (no black screen) @mobile`, async ({ page }) => {
			test.setTimeout(300_000);
			await deploy(ref);
			try {
				await page.goto('/home', { timeout: 30_000 });
				await swReady(page);
				const oldV = await version(page);
				await page.goto('/library', { timeout: 30_000 }); // the old worker caches its shell and pages
				await expect(page.locator('h1').first()).toBeVisible();
				const oldCaches = await page.evaluate(() => caches.keys());
				expect(oldCaches.length).toBeGreaterThan(0);

				await deploy(null); // ── this code goes live ──

				// The still-open old tab navigates client-side: it must end on a working page.
				await page.locator('a[href="/stats"]:visible').first().click({ timeout: 15_000 });
				await expect(page).toHaveURL(/\/stats$/, { timeout: 30_000 });
				await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });

				// Reopening the PWA (a cold start, same device, old worker still installed).
				const reopened = await page.context().newPage();
				await reopened.goto('/home', { timeout: 30_000 });
				await expect(reopened.getByText(/Today's pick · \d+ of \d+/)).toBeVisible({ timeout: 30_000 });
				await expect.poll(() => booted(reopened), { timeout: 30_000 }).toBe(true);
				await expect(reopened.locator('#rotor-boot-panel')).toHaveCount(0);
				const newV = await version(reopened);
				expect(newV).not.toBe(oldV);
				// The new worker takes over and drops every cache of the old release.
				await expect
					.poll(async () => (await reopened.evaluate(() => caches.keys())).filter((k) => !k.endsWith(newV)), { timeout: 60_000 })
					.toEqual([]);
				await reopened.goto('/library', { timeout: 30_000 });
				await expect(reopened.locator('h1').first()).toBeVisible();
				await reopened.close();
			} finally {
				await deploy(null);
			}
		});
	}

	test('HF-3 a dead /_app/ chunk (stale shell after a deploy) resets the worker + caches once and the app starts @laptop', async ({ page, errors }) => {
		let fails = 1;
		await page.route('**/_app/immutable/entry/start.*.js', (route) => (fails-- > 0 ? route.fulfill({ status: 404, body: 'gone' }) : route.continue()));
		await page.goto('/home');
		await expect(page.getByText(/Today's pick · \d+ of \d+/)).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => booted(page)).toBe(true);
		expect(fails).toBeLessThan(0); // the chunk was requested again after the reset
		expect(await page.evaluate(() => sessionStorage.getItem('rotor-boot-reset'))).toMatch(/^\d+$/);
		await expect(page).not.toHaveURL(/rotor-reset=/); // the marker is cleaned up after a good start
		errors.splice(0); // the deliberate 404 import failure
	});

	test('HF-4 if it keeps failing: a visible "couldn’t start" panel with Reload + Reset, never a dark empty page @mobile', async ({ page, errors }) => {
		await page.route('**/_app/immutable/entry/start.*.js', (route) => route.fulfill({ status: 404, body: 'gone' }));
		await page.goto('/home');
		const panel = page.locator('#rotor-boot-panel');
		await expect(panel).toBeVisible({ timeout: 30_000 }); // reset once, failed again → panel, no reload loop
		await expect(panel.getByRole('heading', { name: 'Rotor couldn’t start' })).toBeVisible();
		const colors = await panel.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
		expect(colors).toEqual({ bg: 'rgb(11, 11, 14)', fg: 'rgb(245, 245, 247)' });
		await expect(panel.getByRole('button', { name: 'Reset Rotor on this device' })).toBeVisible();
		await page.unroute('**/_app/immutable/entry/start.*.js');
		await panel.getByRole('button', { name: 'Reload' }).click();
		await expect(page.getByText(/Today's pick · \d+ of \d+/)).toBeVisible({ timeout: 30_000 });
		await expect(panel).toHaveCount(0);
		errors.splice(0); // the deliberate 404 import failures
	});

	test('HF-5 a hung start shows the panel after 15 s; the app replaces it once it starts @laptop', async ({ page }) => {
		test.setTimeout(90_000);
		let release!: () => void;
		const gate = new Promise<void>((ok) => (release = ok));
		await page.route('**/_app/immutable/entry/start.*.js', async (route) => {
			await gate;
			await route.continue();
		});
		await page.goto('/home', { waitUntil: 'commit' });
		await expect(page.locator('#rotor-boot-panel')).toHaveAttribute('data-reason', 'timeout', { timeout: 25_000 });
		await expect(page.getByRole('heading', { name: 'Rotor is taking long to start' })).toBeVisible();
		release();
		await expect(page.getByText(/Today's pick · \d+ of \d+/)).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('#rotor-boot-panel')).toHaveCount(0);
	});

	test('HF-6 error pages are visible pages with a way out @both', async ({ page }) => {
		const res = await page.goto('/no-such-page-in-rotor');
		expect(res?.status()).toBe(404);
		await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
		const fg = await page.locator('h1').evaluate((el) => getComputedStyle(el).color);
		expect(fg).toBe('rgb(245, 245, 247)');
	});

	test('HF-7 a new worker taking over an open tab: the next navigation is a full load onto the new build @laptop', async ({ page }) => {
		test.setTimeout(180_000);
		await page.goto('/home');
		await swReady(page);
		const v1 = await version(page);
		await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
		const r = await fetch(`${CTL}/redeploy`, { method: 'POST' });
		expect(r.ok).toBe(true);
		// What a return to the foreground does (root layout): check for a new worker.
		await page.evaluate(() => navigator.serviceWorker.getRegistration().then((reg) => reg?.update()));
		await page.waitForFunction(
			(old) => fetch('/_app/version.json', { cache: 'no-store' }).then((x) => x.json()).then((j) => j.version !== old),
			v1,
			{ timeout: 30_000 }
		);
		await expect.poll(() => page.evaluate(() => caches.keys()), { timeout: 60_000 }).not.toContainEqual(expect.stringContaining(v1));
		// The click must become a real page load (not a client-side navigation on the old code).
		await Promise.all([page.waitForEvent('load', { timeout: 30_000 }), page.locator('a[href="/library"]:visible').first().click({ timeout: 15_000 })]);
		await expect(page).toHaveURL(/\/library$/);
		await expect(page.locator('h1').first()).toBeVisible();
		expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBeUndefined();
		expect(await booted(page)).toBe(true);
	});
});

