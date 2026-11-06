/** R6: Rotor Wrapped — frozen full-year stories, "so far", story controls, PNG export, top-100 playlist. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const thisYear = () => Number(sql(`SELECT extract(year FROM now() AT TIME ZONE 'Europe/Amsterdam')::int`));
const story = (page: import('@playwright/test').Page) => page.locator('.story');
const idx = async (page: import('@playwright/test').Page) => Number(await story(page).getAttribute('data-index'));

/** Freeze a past year through the real job path (hub → GitHub dispatch mock → Python runner). */
async function ensureFrozen(request: import('@playwright/test').APIRequestContext, baseURL: string | undefined, year: number) {
	if (sqlNum(`SELECT count(*) FROM wrapped_snapshots WHERE year = ${year}`) === 1) return;
	const r = await request.post(`/api/wrapped/${year}/freeze`, { headers: origin(baseURL) });
	expect(r.status()).toBe(200);
	await expect.poll(() => sqlNum(`SELECT count(*) FROM wrapped_snapshots WHERE year = ${year}`), { timeout: 30_000 }).toBe(1);
}

test.describe('R6 Rotor Wrapped', () => {
	test('R6-1 Stats › Wrapped lists 2017 → this year: this year "so far", past years built or buildable @both', async ({ page }) => {
		await page.goto('/stats/wrapped');
		await expect(page.getByRole('heading', { name: 'Rotor Wrapped' }).first()).toBeVisible();
		await expect(page.getByText(`${thisYear()} so far`)).toBeVisible();
		await expect(page.locator('.years li')).toHaveCount(thisYear() - 2017);
		await expect(page.locator('.years li').last()).toHaveAttribute('data-year', '2017');
		await expect(page.getByRole('navigation', { name: 'Stats sections' }).getByRole('link', { name: 'Wrapped' })).toHaveAttribute('aria-current', 'page');
	});

	test('R6-2 story controls on the iPhone: tap right/left, swipe, hold to pause, swipe down closes @mobile', async ({ page }) => {
		await page.goto(`/wrapped/${thisYear()}`);
		await expect(story(page)).toBeVisible();
		await expect(story(page)).toHaveAttribute('data-card', 'intro');
		const card = page.locator('.story .card');
		const box = (await card.boundingBox())!;
		await card.click({ position: { x: box.width * 0.85, y: box.height / 2 } });
		expect(await idx(page)).toBe(1);
		await card.click({ position: { x: box.width * 0.1, y: box.height / 2 } });
		expect(await idx(page)).toBe(0);
		// Swipe left = next.
		await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
		await page.mouse.up();
		expect(await idx(page)).toBe(1);
		// Hold pauses, release resumes without moving on.
		await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
		await page.mouse.down();
		await expect(story(page)).toHaveAttribute('data-paused', 'true');
		await page.mouse.up();
		await expect(story(page)).toHaveAttribute('data-paused', 'false');
		expect(await idx(page)).toBe(1);
		// The progress bar: one segment per card, earlier segments full.
		const n = await page.locator('.story .bar').count();
		expect(n).toBeGreaterThanOrEqual(6);
		expect(await page.locator('.story .fill').first().getAttribute('style')).toContain('scaleX(1)');
		// Swipe down closes.
		await page.mouse.move(box.x + box.width / 2, box.y + 100);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, box.y + 400, { steps: 5 });
		await page.mouse.up();
		await expect(page).toHaveURL(/\/stats\/wrapped$/);
	});

	test('R6-3 laptop: ← / → step, Space pauses, the story auto-advances, Esc closes @laptop', async ({ page }) => {
		await page.goto(`/wrapped/${thisYear()}?from=/home`);
		await expect(story(page)).toHaveAttribute('data-card', 'intro');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		expect(await idx(page)).toBe(2);
		await page.keyboard.press('ArrowLeft');
		expect(await idx(page)).toBe(1);
		await page.keyboard.press(' ');
		await expect(story(page)).toHaveAttribute('data-paused', 'true');
		await page.keyboard.press(' ');
		await expect(story(page)).toHaveAttribute('data-paused', 'false');
		await expect.poll(() => idx(page), { timeout: 12_000 }).toBe(2); // 7 s per card
		await page.keyboard.press('Escape');
		await expect(page).toHaveURL(/\/home$/);
	});

	test('R6-4 build last year once (job), frozen afterwards; numbers equal Year in review @laptop', async ({ page, request, baseURL }) => {
		const y = thisYear() - 1;
		sql(`DELETE FROM wrapped_snapshots WHERE year = ${y}`);
		await page.goto('/stats/wrapped');
		const row = page.locator(`.years li[data-year="${y}"]`);
		await expect(row).toHaveAttribute('data-status', 'buildable');
		await row.getByRole('button', { name: 'Build' }).click();
		await expect(page.getByText(`Rotor Wrapped ${y} is ready`).first()).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(`.years li[data-year="${y}"]`)).toHaveAttribute('data-status', 'frozen', { timeout: 10_000 });
		expect(sql(`SELECT source FROM wrapped_snapshots WHERE year = ${y}`)).toBe('job');
		const at = sql(`SELECT generated_at FROM wrapped_snapshots WHERE year = ${y}`);

		// The numbers: plays = Streamlit's population for the year; top track = Stats › Year.
		const w = await (await request.get(`/api/wrapped/${y}`)).json();
		expect(w.mode).toBe('frozen');
		expect(w.payload.totals.plays).toBe(sqlNum(`SELECT count(*) FROM unified_plays WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = ${y}`));
		const yr = await (await request.get(`/api/stats/year?year=${y}`)).json();
		expect(w.payload.topTracks.slice(0, 10).map((t: { plays: number }) => t.plays)).toEqual(yr.topTracks.map((t: { plays: number }) => t.plays));
		expect(w.payload.totals.noMsPlays).toBe(0); // export plays only (the seed's API plays are in the last 30 days)

		// Frozen: a later play in that year doesn't change it, and building again is a no-op.
		sql(`INSERT INTO spotify_plays (played_at, ms_played, track_uri, track_name, artist_name, album_name, reason_end)
			SELECT timestamptz '${y}-07-01 12:00:00+00', 180000, track_uri, track_name, artist_name, album_name, 'trackdone' FROM spotify_plays WHERE track_uri IS NOT NULL LIMIT 1`);
		sql('SELECT hub.refresh_rollups(true)');
		const again = await request.post(`/api/wrapped/${y}/freeze`, { headers: origin(baseURL) });
		expect(again.status()).toBe(200);
		await expect.poll(() => sql(`SELECT count(*) FILTER (WHERE status IN ('queued','running')) FROM hub_jobs WHERE kind = 'wrapped_build'`), { timeout: 30_000 }).toBe('0');
		expect(sql(`SELECT generated_at FROM wrapped_snapshots WHERE year = ${y}`)).toBe(at);
		expect((await (await request.get(`/api/wrapped/${y}`)).json()).payload.totals.plays).toBe(w.payload.totals.plays);
		expect(() => sql(`UPDATE wrapped_snapshots SET build_ms = 0 WHERE year = ${y}`)).toThrow(/frozen/);
		// This year can't be frozen.
		expect((await request.post(`/api/wrapped/${thisYear()}/freeze`, { headers: origin(baseURL) })).status()).toBe(400);
	});

	test('R6-5 every card renders; Save image exports a 1080×1920 PNG on the device @laptop', async ({ page, request, baseURL }) => {
		const y = thisYear() - 1;
		await ensureFrozen(request, baseURL, y);
		await page.goto(`/wrapped/${y}`);
		const seen = new Set<string>();
		const n = await page.locator('.story .bar').count();
		for (let i = 0; i < n; i++) {
			seen.add((await story(page).getAttribute('data-card'))!);
			await expect(page.locator('.story .svg svg')).toBeVisible();
			if (i < n - 1) await page.keyboard.press('ArrowRight');
		}
		for (const k of ['intro', 'totals', 'top_artists', 'top_tracks', 'clock', 'streak', 'month', 'outro']) expect(seen, k).toContain(k);
		const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save image' }).click()]);
		expect(dl.suggestedFilename()).toMatch(new RegExp(`^rotor-wrapped-${y}-\\d+-outro\\.png$`));
		const png = readFileSync((await dl.path())!);
		expect(png.subarray(1, 4).toString()).toBe('PNG');
		expect(png.readUInt32BE(16)).toBe(1080); // IHDR width
		expect(png.readUInt32BE(20)).toBe(1920); // IHDR height
		expect(png.length).toBeGreaterThan(20_000);
	});

	test('R6-6 Play your top 100 writes only "Wrapped <year> · Auto 🤖📸" (guarded) and plays it; again = same playlist @laptop', async ({ page, request, baseURL }) => {
		const y = thisYear() - 1;
		await ensureFrozen(request, baseURL, y);
		const name = `Wrapped ${y} · Auto 🤖📸`;
		await mock.resetCalls();
		const state = page.waitForResponse((r) => r.url().includes('/api/player/state') && r.ok());
		await page.goto(`/wrapped/${y}`);
		await state; // the player knows the active device (iPhone) before Play is pressed
		const n = await page.locator('.story .bar').count();
		for (let i = 0; i < n - 1; i++) await page.keyboard.press('ArrowRight');
		await expect(story(page)).toHaveAttribute('data-card', 'outro');
		await page.getByRole('button', { name: 'Play your top 100' }).click();
		await expect(page.getByText(`Playing ${name}`)).toBeVisible({ timeout: 15_000 });
		const st = await mock.state();
		const pls = Object.values(st.playlists as Record<string, { id: string; name: string; items: string[] }>).filter((p) => p.name === name);
		expect(pls).toHaveLength(1);
		const w = await (await request.get(`/api/wrapped/${y}`)).json();
		const want = [...new Set(w.payload.topTracks.map((t: { uri: string }) => t.uri))].slice(0, 100);
		expect(pls[0]!.items).toEqual(want);
		expect(st.playback.context_uri).toBe(`spotify:playlist:${pls[0]!.id}`);
		const writes = await mock.writes();
		for (const c of writes) expect([`/v1/me/playlists`, `/v1/playlists/${pls[0]!.id}/items`, '/v1/me/player/play']).toContain(c.path);
		// Second press: replaced, not a second playlist.
		await page.getByRole('button', { name: 'Play your top 100' }).click();
		await expect(page.getByText(`Playing ${name}`).first()).toBeVisible({ timeout: 15_000 });
		const st2 = await mock.state();
		expect(Object.values(st2.playlists as Record<string, { name: string }>).filter((p) => p.name === name)).toHaveLength(1);
		expect((await mock.writes()).filter((c) => c.method === 'POST' && c.path === '/v1/me/playlists')).toHaveLength(1);
		// Its playlist page points back to Wrapped instead of offering a snapshot Rebuild.
		await page.goto(`/playlist/${pls[0]!.id}`);
		await expect(page.getByRole('link', { name: `Open Rotor Wrapped ${y}` })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Rebuild' })).toHaveCount(0);
		expect((await request.post(`/api/playlists/${pls[0]!.id}/rebuild`, { headers: origin(baseURL) })).status()).toBe(400);
	});

	test('R6-7 a year without plays (2018) builds and shows intro + outro only @laptop', async ({ page, request, baseURL }) => {
		await ensureFrozen(request, baseURL, 2018);
		await page.goto('/wrapped/2018');
		await expect(story(page)).toHaveAttribute('data-card', 'intro');
		await expect(page.locator('.story .bar')).toHaveCount(2);
		await expect(page.getByRole('img', { name: 'Rotor Wrapped 2018' })).toBeVisible();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('button', { name: 'Play your top 100' })).toHaveCount(0);
	});

	test('R6-8 "so far" is live: hours with ≈ (API plays without ms_played), payload < 300 ms @laptop', async ({ request }) => {
		const y = thisYear();
		const r = await (await request.get(`/api/wrapped/${y}`)).json();
		expect(r.mode).toBe('so_far');
		expect(r.payload.live).toBe(true);
		expect(r.payload.through).toBe(sql(`SELECT (now() AT TIME ZONE 'Europe/Amsterdam')::date`));
		expect(r.payload.totals.noMsPlays).toBeGreaterThan(0); // the seed's last 30 days are API plays
		expect(r.payload.totals.ms).toBe(sqlNum(`SELECT coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0) FROM spotify_plays sp
			LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
			WHERE sp.track_uri IS NOT NULL AND EXTRACT(YEAR FROM sp.played_at AT TIME ZONE 'Europe/Amsterdam') = ${y}
			AND (sp.played_at AT TIME ZONE 'Europe/Amsterdam')::date <= (now() AT TIME ZONE 'Europe/Amsterdam')::date`));
		const plays = sqlNum('SELECT count(*) FROM spotify_plays');
		const soFar = JSON.parse(sql(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT hub.wrapped_payload(${y}, (now() AT TIME ZONE 'Europe/Amsterdam')::date)`))[0]['Execution Time'];
		const t0 = Date.now();
		const res = await request.get(`/api/wrapped/${y}`, { headers: { 'Cache-Control': 'no-cache' } });
		const api = Date.now() - t0;
		expect(res.status()).toBe(200);
		const build = JSON.parse(sql(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT hub.wrapped_payload(${y - 1}, '${y - 1}-12-31')`))[0]['Execution Time'];
		console.log(`[perf] ${plays} plays · wrapped so far ${soFar.toFixed(1)} ms (SQL) / ${api} ms (API) · one full year ${build.toFixed(1)} ms`);
		expect(soFar).toBeLessThan(300);
	});

	test('R6-9 the daily run freezes last year when it is missing, with one push @laptop', async () => {
		const y = thisYear() - 1;
		sql(`DELETE FROM wrapped_snapshots WHERE year = ${y}`);
		sql(`DELETE FROM push_log WHERE dedupe_key = 'wrapped:${y}'`);
		const before = (await mock.pushes()).filter((p) => p.data.kind === 'wrapped').length;
		const run = () => execFileSync('uv', ['run', '--no-sync', 'python', 'hub/e2e/run_job_mocked.py', '--daily'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, E2E_SPOTIFY_PREFIX: 'http://127.0.0.1:55433/v1/' } });
		run();
		expect(sql(`SELECT source FROM wrapped_snapshots WHERE year = ${y}`)).toBe('daily');
		run();
		const pushes = (await mock.pushes()).filter((p) => p.data.kind === 'wrapped');
		expect(pushes.length - before).toBe(1);
		expect(pushes.at(-1)!.data.url).toBe(`/wrapped/${y}`);
	});

	test('R6-10 Home shows the Wrapped card in December and January only @mobile', async ({ page }) => {
		await page.clock.setFixedTime(new Date('2026-12-05T10:00:00+01:00'));
		await page.goto('/home');
		await expect(page.getByTestId('home-wrapped')).toContainText('2026 so far');
		await expect(page.getByTestId('home-wrapped')).toHaveAttribute('href', '/wrapped/2026?from=/home');
		await page.clock.setFixedTime(new Date('2027-01-20T10:00:00+01:00'));
		await page.goto('/home');
		await expect(page.getByTestId('home-wrapped')).toContainText('2026');
		await expect(page.getByTestId('home-wrapped')).not.toContainText('so far');
		await page.clock.setFixedTime(new Date('2026-11-06T10:00:00+01:00'));
		await page.goto('/home');
		await expect(page.getByText('Your week')).toBeVisible();
		await expect(page.getByTestId('home-wrapped')).toHaveCount(0);
	});

	test('R6-11 Wrapped pages: dialog + names, no external requests, no Spotify branding in the cards @both', async ({ page, blocked }) => {
		await page.goto(`/wrapped/${thisYear()}`);
		await expect(page.getByRole('dialog', { name: `Rotor Wrapped ${thisYear()}` })).toBeVisible();
		const issues = await page.evaluate(() => {
			const out: string[] = [];
			document.querySelectorAll('.story button').forEach((b) => !(b.getAttribute('aria-label') ?? b.textContent ?? '').trim() && out.push(b.outerHTML.slice(0, 80)));
			if (/spotify/i.test(document.querySelector('.story .svg')?.innerHTML ?? '')) out.push('card mentions Spotify');
			if (document.querySelector('.story .svg image')) out.push('card has an <image>');
			return out;
		});
		expect(issues).toEqual([]);
		expect(blocked).toEqual([]);
	});
});
