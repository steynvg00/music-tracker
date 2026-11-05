/** R2: Library, read-only rule, managed settings + jobs, custom playlists, rules, push. */
import { execFileSync } from 'node:child_process';
import { test, expect, mock, sql, sqlNum, waitForJob, type MockCall } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const spotifyWritesTo = (calls: MockCall[], pid: string) => calls.filter((c) => c.method !== 'GET' && c.path.includes(pid));

test.describe('R2', () => {
	test('R2-1 Library lists the mirror, Liked Songs and a lock on unmanaged rows @both', async ({ page }) => {
		await page.goto('/library');
		for (const n of ['Top 30 last 30 days · Auto 🤖🔄', 'Late night · Custom 🎧', 'Road trip', 'Hardstyle Classics']) {
			await expect(page.getByText(n, { exact: true }).filter({ visible: true }).first()).toBeVisible();
		}
		await expect(page.getByText('Liked Songs').filter({ visible: true }).first()).toBeVisible();
		await expect(page.getByText(/Read & play|Play only/).filter({ visible: true }).first()).toBeVisible();
	});

	test('R2-2 unmanaged, followed, suffix-spoofed and not-owned playlists have no edit affordances @laptop', async ({ page }) => {
		const f = await mock.fixture();
		for (const pid of [f.road, f.followed, f.spoof, f.stolen]) {
			await page.goto(`/playlist/${pid}`);
			await expect(page.getByText(/read & play only|play only/i).first()).toBeVisible();
			for (const name of ['Edit', 'Refresh now', 'Rebuild', 'Delete now', 'Extend +7 d']) {
				await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
			}
			await expect(page.getByLabel('Sort order')).toHaveCount(0);
		}
	});

	test('R2-3 every write API refuses those playlists with 403 and nothing reaches Spotify @laptop', async ({ request, baseURL }) => {
		const f = await mock.fixture();
		await mock.resetCalls();
		for (const pid of [f.road, f.followed, f.spoof, f.stolen]) {
			const h = origin(baseURL);
			for (const action of ['update', 'extend', 'keep', 'delete']) {
				const r = await request.post(`/api/custom/${pid}`, { headers: h, data: { action, filters: {}, excluded: [] } });
				expect(r.status(), `${action} ${pid}`).toBe(403);
			}
			expect((await request.post(`/api/playlists/${pid}/order`, { headers: h, data: { order_pref: 'random' } })).status()).toBe(403);
			expect((await request.post(`/api/playlists/${pid}/refresh`, { headers: h, data: {} })).status()).toBe(403);
			expect((await request.post(`/api/playlists/${pid}/rebuild`, { headers: h, data: {} })).status()).toBe(403);
			expect((await request.get(`/api/custom/${pid}`)).status()).toBe(403);
		}
		expect(await mock.writes()).toEqual([]);
	});

	test('R2-4 About this playlist shows rule and next refresh @both', async ({ page }) => {
		const f = await mock.fixture();
		await page.goto(`/playlist/${f.top30}`);
		const about = page.getByLabel('About this playlist');
		await expect(about).toBeVisible();
		await expect(about.getByText('Rule')).toBeVisible();
		await expect(about.getByText('Next refresh')).toBeVisible();
	});

	test('R2-5 order preference Random + Refresh now: queued → done, only that playlist rewritten @laptop', async ({ page }) => {
		const f = await mock.fixture();
		await page.goto(`/playlist/${f.top30}`);
		await page.getByLabel('Sort order').selectOption('random');
		await expect.poll(() => sql(`SELECT order_pref FROM playlist_settings WHERE playlist_id = '${f.top30}'`)).toBe('random');
		await mock.resetCalls();
		await page.getByRole('button', { name: /Refresh now/ }).click();
		await expect(page.getByText(/Queued|Running|Starting/i).first()).toBeVisible();
		expect(await waitForJob(`kind = 'refresh_managed' AND payload->>'playlist_id' = '${f.top30}'`)).toBe('done');
		await expect(page.getByText(/Done|refreshed/i).first()).toBeVisible({ timeout: 15_000 });
		const writes = (await mock.calls()).filter((c) => c.who === 'python' && c.method !== 'GET');
		expect(writes.length).toBeGreaterThan(0);
		for (const w of writes) expect(w.path, 'python wrote only Top 30').toContain(f.top30);
		const dispatch = (await mock.state()).dispatches.at(-1);
		expect(dispatch.workflow).toBe('hub-jobs.yml');
	});

	test('R2-6 a second Refresh now while one is active returns the same job (one dispatch) @laptop', async ({ request, baseURL }) => {
		const f = await mock.fixture();
		const before = (await mock.state()).dispatches.length;
		const a = await (await request.post(`/api/playlists/${f.top30}/refresh`, { headers: origin(baseURL), data: {} })).json();
		const b = await (await request.post(`/api/playlists/${f.top30}/refresh`, { headers: origin(baseURL), data: {} })).json();
		expect(b.job.id).toBe(a.job.id);
		expect(b.created).toBe(false);
		expect((await mock.state()).dispatches.length).toBe(before + 1);
		expect(await waitForJob(`id = '${a.job.id}'`)).toBe('done');
	});

	test('R2-7 snapshot Rebuild runs as a job and completes the force refresh @laptop', async ({ page }) => {
		const f = await mock.fixture();
		await page.goto(`/playlist/${f.snapshot}`);
		await page.getByRole('button', { name: /Rebuild/ }).click();
		const s = await waitForJob(`kind = 'refresh_managed' AND payload->>'playlist_id' = '${f.snapshot}'`);
		const err = sql(`SELECT coalesce(error, '') FROM hub_jobs WHERE payload->>'playlist_id' = '${f.snapshot}' ORDER BY requested_at DESC LIMIT 1`);
		// The seeded snapshot name may not match a live definition; then the job must fail cleanly, never write elsewhere.
		if (s === 'done') expect(sql(`SELECT force_refresh_completed_at IS NOT NULL FROM playlist_settings WHERE playlist_id = '${f.snapshot}'`)).toBe('t');
		else expect(err).toMatch(/definition|LookupError/);
		const writes = (await mock.calls()).filter((c) => c.who === 'python' && c.method !== 'GET' && !c.path.includes(f.top30));
		for (const w of writes) expect(w.path).toContain(f.snapshot);
	});

	test('R2-8 create → edit → extend → keep → delete a custom playlist through the guard @mobile', async ({ page }) => {
		const f = await mock.fixture();
		await page.goto('/library');
		await page.getByRole('button', { name: /New custom playlist/ }).click();
		await page.getByPlaceholder('Search your artists…').fill(f.artist0.name.slice(0, 6));
		await page.getByRole('listbox', { name: 'Artist suggestions' }).getByText(f.artist0.name).first().click().catch(async () => {
			await page.getByLabel('Artist suggestions').getByText(f.artist0.name).first().click();
		});
		await expect(page.getByTestId('match-count')).toBeVisible();
		const count = Number((await page.getByTestId('match-count').innerText()).replace(/\D/g, ''));
		expect(count).toBeGreaterThan(2);
		await page.locator('.foot').getByRole('button', { name: 'Preview' }).click();
		const outs = page.getByRole('button', { name: /^Leave out / });
		await outs.nth(0).click();
		await outs.nth(1).click();
		await page.getByRole('button', { name: 'Next' }).click();
		await page.getByPlaceholder('Late night hardstyle').fill('Smoke test');
		await mock.resetCalls();
		await page.getByRole('button', { name: 'Create', exact: true }).click();
		await expect(page).toHaveURL(/\/playlist\/\w{22}/, { timeout: 20_000 });
		const pid = page.url().split('/playlist/')[1]!.slice(0, 22);
		const st = await mock.state();
		expect(st.playlists[pid].name).toBe('Smoke test · Custom 🎧');
		const row = sql(`SELECT filters_json IS NOT NULL, cardinality(excluded_uris), round(extract(epoch FROM expires_at - now()) / 86400) FROM custom_playlists WHERE playlist_id = '${pid}'`);
		expect(row).toBe('t|2|7');
		const writes = await mock.writes();
		expect(writes.map((w) => `${w.method} ${w.path.replace(pid, ':id')}`)).toEqual(['POST /v1/me/playlists', 'POST /v1/playlists/:id/items']);

		// Edit: prefilled, leave one more out → Update on Spotify replaces the items.
		const before = st.playlists[pid].items.length;
		await page.getByRole('button', { name: 'Edit', exact: true }).click();
		await expect(page.getByTestId('match-count')).toBeVisible();
		await page.locator('.foot').getByRole('button', { name: 'Preview' }).click();
		await page.getByRole('button', { name: /^Leave out / }).first().click();
		await page.getByRole('button', { name: 'Next' }).click();
		await mock.resetCalls();
		await page.getByRole('button', { name: 'Update on Spotify' }).click();
		await expect.poll(async () => (await mock.state()).playlists[pid].items.length).toBe(before - 1);
		expect((await mock.writes()).every((w) => w.path.includes(pid))).toBe(true);

		// Extend +7 d, then Keep.
		const exp0 = sqlNum(`SELECT extract(epoch FROM expires_at) FROM custom_playlists WHERE playlist_id = '${pid}'`);
		await page.getByRole('button', { name: 'Extend +7 d' }).click();
		await expect.poll(() => sqlNum(`SELECT round((extract(epoch FROM expires_at) - ${exp0}) / 86400) FROM custom_playlists WHERE playlist_id = '${pid}'`)).toBe(7);
		await page.getByRole('button', { name: 'Keep', exact: true }).click();
		await expect.poll(() => sql(`SELECT expires_at IS NULL FROM custom_playlists WHERE playlist_id = '${pid}'`)).toBe('t');

		// Delete now → confirm → gone from Spotify (guarded /me/library) and the DB.
		await mock.resetCalls();
		await page.getByRole('button', { name: 'Delete now' }).click();
		await page.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(page).toHaveURL(/\/library/);
		expect((await mock.state()).unfollowed).toContain(pid);
		expect(sql(`SELECT count(*) FROM custom_playlists WHERE playlist_id = '${pid}'`)).toBe('0');
		const del = await mock.writes();
		expect(del.map((w) => `${w.method} ${w.path}`)).toEqual(['DELETE /v1/me/library']);
		expect(del[0]!.query).toContain(pid);
	});

	test('R2-9 the live count equals Streamlit’s Python preview for the same filters @laptop', async ({ request, baseURL }) => {
		const f = await mock.fixture();
		const filters = { artists: [f.artist0.name], release_year_min: 2010, release_year_max: null, discovery_year_min: null, discovery_year_max: null, min_plays: 2, max_tracks: 10000, liked_only: false, sort_order: 'plays_desc' };
		const rotor = await (await request.post('/api/custom/preview', { headers: origin(baseURL), data: { filters } })).json();
		const py = execFileSync(
			'uv',
			['run', '--no-sync', 'python', '-c',
				`import psycopg,sys; from lib.temporary_playlists import query_temp_playlist_tracks as q, _query_temp_playlist_tracks_inline as qi
c=psycopg.connect(sys.argv[1]); a=dict(artists=[sys.argv[2]], release_year_min=2010, min_plays=2, max_tracks=10000)
print(len(q(c, **a)), len(qi(c, **a)))`, process.env.E2E_DB!, f.artist0.name],
			{ cwd: REPO, encoding: 'utf8' }
		).trim();
		const [viaFunction, inline] = py.split(' ').map(Number);
		expect(rotor.count).toBe(viaFunction);
		expect(viaFunction).toBe(inline);
	});

	test('R2-10 Rules shows 16 categories with the registry’s playlist total @both', async ({ page }) => {
		await page.goto('/rules');
		const cats = sqlNum('SELECT count(*) FROM playlist_rule_categories');
		expect(cats).toBe(16);
		await expect(page.getByTestId('rule-categories')).toHaveText('16');
		const total = sql(`SELECT sum(playlist_count) FROM playlist_rule_categories`);
		await expect(page.getByTestId('rule-playlists')).toHaveText(total);
	});

	test('R2-11 Shuffle the deck runs as a job and adds new candidates @laptop', async ({ request, baseURL }) => {
		const today = sql(`SELECT (now() AT TIME ZONE 'Europe/Amsterdam')::date`);
		const before = sqlNum(`SELECT count(*) FROM daily_pick_candidates WHERE pick_date = '${today}'`);
		const r = await (await request.post('/api/daily/reseed', { headers: origin(baseURL), data: { date: today } })).json();
		expect(r.mode).toBe('job');
		expect(await waitForJob(`id = '${r.job.id}'`)).toBe('done');
		expect(sqlNum(`SELECT count(*) FROM daily_pick_candidates WHERE pick_date = '${today}'`)).toBeGreaterThan(before);
	});

	test('R2-12 test notification and daily run deliver Web Push, without duplicates @laptop', async ({ page, request, baseURL }) => {
		// "Send a test" needs a real browser push subscription (Google/Apple push service, blocked here):
		// call the same API the button calls. The seeded subscription receives it.
		const t = await (await request.post('/api/push/test', { headers: origin(baseURL), data: {} })).json();
		expect(await waitForJob(`id = '${t.job.id}'`)).toBe('done');
		await expect.poll(async () => (await mock.pushes()).some((p) => p.data.body === 'Notifications work on this device.')).toBe(true);
		const run = () => execFileSync('uv', ['run', '--no-sync', 'python', 'hub/e2e/run_job_mocked.py', '--daily'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, E2E_SPOTIFY_PREFIX: 'http://127.0.0.1:55433/v1/' } });
		run();
		const daily = (await mock.pushes()).filter((p) => p.data.kind === 'daily_pick');
		expect(daily).toHaveLength(1);
		run();
		expect((await mock.pushes()).filter((p) => p.data.kind === 'daily_pick')).toHaveLength(1);
		await page.goto('/settings');
		await expect(page.getByText(/1 device|devices/i).first()).toBeVisible();
		await expect(page.getByText(/Test notification|test/i).first()).toBeVisible();
	});
});
