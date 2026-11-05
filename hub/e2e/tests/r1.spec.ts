/** R1 regression: sign-in gate, Home deck, player + devices, wake flow, quiet hidden tab. */
import { test, expect, mock, signIn, sql } from './fixtures';

const today = () => sql(`SELECT (now() AT TIME ZONE 'Europe/Amsterdam')::date`);
const resetDeck = () => sql(`DELETE FROM daily_pick_state WHERE pick_date = '${today()}'`);
const PLAYING_IPHONE = (f: Record<string, any>) => ({
	devices: [
		{ id: 'dev-iphone', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false, supports_volume: false, volume_percent: null },
		{ id: 'dev-speaker', name: 'Living room', type: 'Speaker', is_active: false, is_restricted: false, supports_volume: true, volume_percent: 40 }
	],
	playback: { device_id: 'dev-iphone', is_playing: false, item_uri: f.track0, progress_ms: 30000, context_uri: `spotify:playlist:${f.top30}`, index: 0 }
});

test.describe('R1 signed out', () => {
	test.use({ storageState: { cookies: [], origins: [] } });
	test('R1-1 a non-owner Spotify account is rejected after OAuth @laptop', async ({ page, context }) => {
		await signIn(page, 'stranger');
		await expect(page).toHaveURL(/\/login/);
		await page.goto('/home');
		await expect(page).toHaveURL(/\/login/);
		expect((await context.cookies()).some((c) => c.name === 'rotor_session')).toBe(false);
		expect(sql(`SELECT count(*) FROM hub_oauth_tokens WHERE account_id = 'stranger'`)).toBe('0');
		await mock.set({ loginUser: null });
	});
});

test.describe('R1', () => {
	test.beforeEach(async () => {
		await mock.set(PLAYING_IPHONE(await mock.fixture()));
	});

	test('R1-2 Home hero shows today’s pick 1 of 5 @both', async ({ page }) => {
		resetDeck();
		await page.goto('/home');
		await expect(page.getByText(/Today's pick · 1 of 5/)).toBeVisible();
	});

	test('R1-3 the player shows the active device @both', async ({ page }) => {
		await page.goto('/home');
		await expect(page.getByText('iPhone').first()).toBeVisible();
	});

	test('R1-4 rotating ×4 makes no Spotify writes and ends at Shuffle the deck @mobile', async ({ page }) => {
		resetDeck();
		await page.goto('/home');
		await expect(page.getByText(/1 of 5/)).toBeVisible();
		await mock.resetCalls();
		for (let i = 2; i <= 5; i++) {
			await page.getByRole('button', { name: 'Rotate', exact: true }).click();
			await expect(page.getByText(new RegExp(`${i} of 5`))).toBeVisible();
		}
		await expect(page.getByRole('button', { name: /Shuffle the deck/ })).toBeVisible();
		expect(await mock.writes()).toEqual([]);
	});

	test('R1-5 Play a generated pick writes only Daily pick · Auto 🤖🔄 (guarded), then plays @mobile', async ({ page }) => {
		resetDeck();
		sql(`UPDATE daily_pick_state SET current_rank = 1 WHERE pick_date = '${today()}'`);
		await page.goto('/home');
		await expect(page.getByText(/1 of 5/)).toBeVisible();
		const kind = sql(`SELECT kind FROM daily_pick_candidates WHERE pick_date = '${today()}' AND rank = 1`);
		await mock.resetCalls();
		await page.getByRole('button', { name: /Play today's pick/ }).click();
		await expect.poll(async () => (await mock.writes()).some((c) => c.path === '/v1/me/player/play')).toBe(true);
		const writes = await mock.writes();
		const st = await mock.state();
		for (const w of writes.filter((c) => c.path.startsWith('/v1/playlists/'))) {
			const pid = w.path.split('/')[3]!;
			expect(st.playlists[pid].name).toBe('Daily pick · Auto 🤖🔄');
		}
		if (kind === 'generated') {
			const created = writes.find((c) => c.path === '/v1/me/playlists');
			if (created) expect((created.body as { name: string }).name).toBe('Daily pick · Auto 🤖🔄');
			expect(writes.some((c) => /\/v1\/playlists\/\w{22}\/items/.test(c.path))).toBe(true);
		}
		await expect(page.getByRole('button', { name: /Pause today's pick/ })).toBeVisible();
	});

	test('R1-6 device picker lists the speaker and transfers to it @laptop', async ({ page }) => {
		await page.goto('/home');
		await page.getByRole('button', { name: /device|iPhone/i }).first().click();
		await expect(page.getByText('Living room')).toBeVisible();
		await mock.resetCalls();
		await page.getByRole('button', { name: /Living room/ }).click();
		await expect.poll(async () => (await mock.writes()).some((c) => c.path === '/v1/me/player' || (c.path === '/v1/me/player/play' && c.query.includes('dev-speaker')))).toBe(true);
	});

	test('R1-7 no device anywhere → "Spotify isn’t open anywhere", then plays once one appears @mobile', async ({ page }) => {
		resetDeck();
		await mock.set({ devices: [], playback: null });
		await page.goto('/home');
		await page.getByRole('button', { name: /Play today's pick/ }).click();
		await expect(page.getByText("Spotify isn't open anywhere")).toBeVisible();
		const f = await mock.fixture();
		await mock.resetCalls();
		// The pending intent polls devices; "open Spotify" is the deep link. Simulate the phone waking up.
		// The spotify: deep link can't open an app here: cancel the navigation, keep Rotor's handler.
		await page.evaluate(() => document.addEventListener('click', (e) => (e.target as Element).closest('a[href^="spotify:"]') && e.preventDefault(), true));
		await page.getByRole('link', { name: /Open Spotify/ }).click();
		await expect(page.getByText('Waiting for Spotify…')).toBeVisible();
		await mock.set(PLAYING_IPHONE(f));
		await expect.poll(async () => (await mock.writes()).some((c) => c.path === '/v1/me/player/play'), { timeout: 20_000 }).toBe(true);
	});

	test('R1-8 a hidden tab makes zero player requests @mobile', async ({ page }) => {
		await page.goto('/home');
		await page.waitForTimeout(1500);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		const seen: string[] = [];
		page.on('request', (r) => r.url().includes('/api/player/') && seen.push(r.url()));
		await page.waitForTimeout(10_000);
		expect(seen).toEqual([]);
	});

	test('R1-9 laptop: Space toggles play/pause @laptop', async ({ page }) => {
		await mock.set({ playback: { ...(await mock.state()).playback, is_playing: true } });
		await page.goto('/home');
		await page.waitForTimeout(800);
		await mock.resetCalls();
		await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
		await page.keyboard.press('Space');
		await expect.poll(async () => (await mock.writes()).some((c) => c.path === '/v1/me/player/pause')).toBe(true);
	});

	test('R1-10 daily pick detail shows the track list @both', async ({ page }) => {
		await page.goto('/daily');
		await expect(page.locator('.row').first()).toBeVisible();
	});

	test('R1-11 Settings shows the Spotify sign-in countdown @both', async ({ page }) => {
		await page.goto('/settings');
		await expect(page.getByText(/^\d+ d$/).first()).toBeVisible();
	});

	test('R1-12 the SDK token endpoint returns an access token only @laptop', async ({ request }) => {
		const r = await request.get('/api/spotify/token');
		expect(r.ok()).toBe(true);
		const body = await r.json();
		expect(typeof body.accessToken === 'string' || typeof body.access_token === 'string').toBe(true);
		expect(JSON.stringify(body)).not.toMatch(/refresh/i);
	});

	test('R1-13 no browser request ever leaves localhost (except the stubbed SDK) @both', async ({ page, blocked }) => {
		for (const p of ['/home', '/library', '/settings', '/daily']) await page.goto(p);
		expect(blocked).toEqual([]);
		const calls = await mock.calls();
		expect(calls.filter((c) => c.blocked || c.unmocked)).toEqual([]);
	});
});
