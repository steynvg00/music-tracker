/** R7: Release radar — three sources (all mocked), merged releases, status, follow, Home shelf, playlist. */
import { execFileSync } from 'node:child_process';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const daily = () =>
	execFileSync('uv', ['run', '--no-sync', 'python', 'hub/e2e/run_job_mocked.py', '--daily'], {
		cwd: REPO,
		encoding: 'utf8',
		env: { ...process.env, E2E_SPOTIFY_PREFIX: 'http://127.0.0.1:55433/v1/' }
	});
const PLAYLIST = 'New from your artists · Auto 🤖🔄';

/** The radar is filled by the daily run; run it once per test file (mobile tests come first). */
function ensureRadar() {
	if (sqlNum(`SELECT count(*) FROM radar_runs`) === 0) daily();
}

test.describe('R7 Release radar', () => {
	test('R7-1 the daily run fills the radar from Spotify, MusicBrainz and Scantraxx; each source reports success @laptop', async () => {
		await mock.resetCalls();
		daily();
		const st = sql(`SELECT string_agg(source || ':' || (last_success_at IS NOT NULL)::text || ':' || coalesce(last_error, '-'), ' ' ORDER BY source) FROM radar_sources`);
		expect(st).toBe('musicbrainz:true:- scantraxx:true:- spotify:true:-');
		const calls = (await mock.calls()).filter((c) => c.who === 'python');
		const mb = calls.filter((c) => c.host === 'musicbrainz.org');
		const label = calls.filter((c) => c.host === 'scantraxx.com');
		expect(mb.length).toBeGreaterThan(0);
		for (const c of [...mb, ...label]) {
			expect(c.ua).toBe('RotorMusicHub/0.87 ( https://github.com/steynvg00/music-tracker )');
			expect(JSON.stringify(c.headers ?? {})).not.toContain('@');
		}
		expect(label.length).toBe(2); // this month + next month, nothing else
		expect(calls.filter((c) => c.host === 'api.spotify.com' && /\/v1\/artists\/[^/]+\/albums$/.test(c.path)).length).toBeGreaterThan(0);
		expect(calls.filter((c) => c.host === 'api.spotify.com' && c.method !== 'GET')).toEqual([]); // the radar never writes to Spotify
	});

	test('R7-2 one release from three sources shows once with three source badges; statuses are right @laptop', async ({ page }) => {
		ensureRadar();
		const f = await mock.fixture();
		expect(sqlNum(`SELECT count(*) FROM radar_releases WHERE title_key = 'shared release'`)).toBe(1);
		await page.goto('/radar?view=recent');
		const shared = page.locator('.rel', { hasText: 'Shared Release' });
		await expect(shared).toHaveCount(1);
		for (const s of ['Spotify', 'MusicBrainz', 'Scantraxx']) await expect(shared.locator('.sb', { hasText: s })).toBeVisible();
		await expect(shared).toHaveAttribute('data-status', 'out');
		await expect(page.locator('.rel', { hasText: 'Already Yours' })).toHaveAttribute('data-status', 'in_library'); // its track was played
		await expect(page.locator('.rel', { hasText: 'E2E Fresh Single' })).toBeVisible();
		await expect(page.locator('.rel', { hasText: 'Never On The Radar' })).toHaveCount(0); // not an artist you listen to
		await page.goto('/radar');
		await expect(page.locator('.rel', { hasText: 'E2E Future Album' })).toHaveAttribute('data-status', 'announced');
		await expect(page.locator('.rel', { hasText: 'E2E Label Exclusive' })).toHaveAttribute('data-status', 'announced');
		// Coming up is soonest first.
		const titles = await page.locator('.rel .t').allTextContents();
		expect(titles.indexOf('E2E Label Exclusive')).toBeLessThan(titles.indexOf('E2E Future Album'));
		// Per-artist filter.
		await page.getByRole('button', { name: new RegExp(`^${f.radar.a1.name} · `) }).click();
		await expect(page).toHaveURL(/artist=/);
		await expect(page.locator('.rel', { hasText: 'E2E Label Exclusive' })).toHaveCount(0);
		await expect(page.locator('.rel', { hasText: 'E2E Future Album' })).toBeVisible();
		await expect(page.locator('.health li')).toHaveCount(3);
		await expect(page.locator('.health li[data-source="musicbrainz"]')).toContainText('last success');
	});

	test('R7-3 Home shows a compact "Coming up" shelf @mobile', async ({ page }) => {
		ensureRadar();
		await page.goto('/home');
		const shelf = page.getByRole('region', { name: 'Coming up' });
		await expect(shelf).toBeVisible();
		await expect(shelf.getByText('E2E Label Exclusive')).toBeVisible();
		await expect(shelf.getByRole('link', { name: 'Release radar' })).toHaveAttribute('href', '/radar');
	});

	test('R7-4 Follow in Rotor on an artist page adds them to the radar after the next run @laptop', async ({ page, request, baseURL }) => {
		ensureRadar();
		const f = await mock.fixture();
		const fa = f.radar.followed;
		// An artist with no plays: no page of their own, so follow through the same API the toggle uses…
		expect((await request.put(`/api/radar/follow/${fa.id}`, { headers: origin(baseURL), data: { name: fa.name } })).status()).toBe(200);
		// …and check the toggle itself on a played artist's page.
		await page.goto(`/artist/${f.radar.a0.id}`);
		const btn = page.getByRole('button', { name: 'Follow in Rotor' });
		await btn.click();
		await expect(page.getByRole('button', { name: '✓ Following in Rotor' })).toHaveAttribute('aria-pressed', 'true');
		expect(sqlNum(`SELECT count(*) FROM radar_followed_artists WHERE artist_id = '${f.radar.a0.id}'`)).toBe(1);
		await page.reload();
		await page.getByRole('button', { name: '✓ Following in Rotor' }).click();
		await expect(page.getByRole('button', { name: 'Follow in Rotor' })).toBeVisible();
		expect(sqlNum(`SELECT count(*) FROM radar_followed_artists WHERE artist_id = '${f.radar.a0.id}'`)).toBe(0);
		expect((await mock.writes()).filter((c) => c.path.includes('/following'))).toEqual([]); // never a Spotify follow
		daily();
		await page.goto('/radar?view=recent&followed=1');
		await expect(page.locator('.rel', { hasText: 'Followed Drop' })).toBeVisible();
		await expect(page.locator('.rel', { hasText: 'Shared Release' })).toHaveCount(0);
	});

	test('R7-5 Update playlist writes only "New from your artists · Auto 🤖🔄" (guarded); again = same playlist @laptop', async ({ page, request, baseURL }) => {
		ensureRadar();
		const f = await mock.fixture();
		await mock.resetCalls();
		await page.goto('/radar');
		await page.getByRole('button', { name: 'Update playlist' }).click();
		await expect(page.getByText(new RegExp(`(Created|Updated) ${PLAYLIST}`))).toBeVisible({ timeout: 15_000 });
		const pls = Object.values((await mock.state()).playlists as Record<string, { id: string; name: string; items: string[] }>).filter((p) => p.name === PLAYLIST);
		expect(pls).toHaveLength(1);
		// Spotify releases of the last 14 days: Fresh Single (2 tracks), Shared Release, Already Yours, Followed Drop (if followed).
		expect(pls[0]!.items).toEqual(expect.arrayContaining([...f.radar.newTracks.slice(0, 2), f.radar.newTracks[3], f.radar.libTrack]));
		expect(pls[0]!.items).not.toContain(f.radar.newTracks[2]); // the 40-day-old album
		for (const c of await mock.writes()) expect(['/v1/me/playlists', `/v1/playlists/${pls[0]!.id}/items`]).toContain(c.path);
		expect((await request.post('/api/radar/playlist', { headers: origin(baseURL) })).status()).toBe(200);
		expect(Object.values((await mock.state()).playlists as Record<string, { name: string }>).filter((p) => p.name === PLAYLIST)).toHaveLength(1);
		// Its page points back to the radar; R2's "Refresh now" refuses it (no definition in lib/playlists.py).
		await page.goto(`/playlist/${pls[0]!.id}`);
		await expect(page.getByRole('link', { name: 'Open Release radar' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Refresh now' })).toHaveCount(0);
		expect((await request.post(`/api/playlists/${pls[0]!.id}/refresh`, { headers: origin(baseURL) })).status()).toBe(400);
	});

	test('R7-6 a source failing 3 days in a row sends exactly one push; the others keep working @laptop', async () => {
		ensureRadar();
		sql(`DELETE FROM push_log WHERE dedupe_key LIKE 'radar-fail:%'`);
		// Two failed days already behind us (the daily run can't be moved in time here).
		sql(`UPDATE radar_sources SET consecutive_failures = 2, failing_since = (now() AT TIME ZONE 'Europe/Amsterdam')::date - 2,
		     failure_notified_at = NULL, last_error = 'HTTP 503' WHERE source = 'musicbrainz'`);
		await mock.set({ musicbrainzDown: true });
		const before = (await mock.pushes()).filter((p) => p.data.kind === 'radar').length;
		try {
			daily();
			daily();
		} finally {
			await mock.set({ musicbrainzDown: false });
		}
		const pushes = (await mock.pushes()).filter((p) => p.data.kind === 'radar');
		expect(pushes.length - before).toBe(1);
		expect(pushes.at(-1)!.data.body).toMatch(/^MusicBrainz has failed 3 days in a row/);
		expect(pushes.at(-1)!.data.url).toBe('/radar');
		expect(sql(`SELECT consecutive_failures || ':' || (failure_notified_at IS NOT NULL) FROM radar_sources WHERE source = 'musicbrainz'`)).toBe('4:true');
		expect(sql(`SELECT last_error IS NULL OR last_success_at > last_error_at FROM radar_sources WHERE source = 'spotify'`)).toBe('t');
		// Recovery resets the streak.
		daily();
		expect(sql(`SELECT consecutive_failures || ':' || (failing_since IS NULL) FROM radar_sources WHERE source = 'musicbrainz'`)).toBe('0:true');
	});

	test('R7-7 Radar pages: one h1, named buttons, nothing leaves localhost @both', async ({ page, blocked }) => {
		ensureRadar();
		for (const p of ['/radar', '/radar?view=recent', '/home']) {
			await page.goto(p);
			await expect(page.locator('h1').first()).toBeVisible();
			const issues = await page.evaluate(() => {
				const out: string[] = [];
				document.querySelectorAll('button').forEach((b) => {
					if (!(b.getAttribute('aria-label') ?? b.textContent ?? '').trim() && !b.closest('[inert]')) out.push(b.outerHTML.slice(0, 80));
				});
				return out;
			});
			expect(issues, p).toEqual([]);
		}
		expect(blocked).toEqual([]);
	});
});
