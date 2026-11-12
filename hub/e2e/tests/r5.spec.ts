/** R5: mixed sessions (experimental, opt-in per device) — conductor, handoffs, failure UIs, relay. */
import { test, expect, mock, sql, sqlNum } from './fixtures';

const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const YT_LIST = 'https://www.youtube.com/playlist?list=PLe2eRotorTestList01';
const SC_TRACK = 'https://soundcloud.com/e2e-artist/e2e-track';
const SDK = { id: 'dev-laptop-sdk', name: 'This laptop', type: 'Computer', is_active: false, is_restricted: false, supports_volume: true, volume_percent: 70 };
const IPHONE = { id: 'dev-iphone', name: 'iPhone', type: 'Smartphone', is_active: true, is_restricted: false, supports_volume: false, volume_percent: null };
const SPEAKER = { id: 'dev-speaker', name: 'Living room', type: 'Speaker', is_active: false, is_restricted: false, supports_volume: true, volume_percent: 40 };
type Req = import('@playwright/test').APIRequestContext;
type Page = import('@playwright/test').Page;

/** Short Spotify tracks so a whole mix runs in seconds; YouTube/SoundCloud items imported once. */
async function setup(request: Req, baseURL: string | undefined, short = 6000) {
	const st = await mock.state();
	const uris = Object.keys(st.tracks).filter((u) => sqlNum(`SELECT count(*) FROM hub.mv_track_stats WHERE track_uri = '${u}'`) > 0).slice(0, 5);
	const tracks = { ...st.tracks };
	for (const u of uris) tracks[u] = { ...tracks[u], duration_ms: short };
	await mock.set({ tracks, soundcloud: { ...(st.soundcloud ?? {}), [SC_TRACK]: { title: 'E2E SoundCloud track', author: 'e2e-artist' } }, autoplay: false });
	// (Re)import when the items are missing: R4's 30-day test deletes stale YouTube data on purpose.
	for (const [url, probe] of [[YT_LIST, 'e2eVid00005'], [SC_TRACK, SC_TRACK]] as const) {
		if (!sql(`SELECT id FROM media_items WHERE source_id = '${probe}'`)) {
			expect((await request.post('/api/collections', { headers: origin(baseURL), data: { url } })).status()).toBe(201);
		}
	}
	const yt = (n: number) => sql(`SELECT id FROM media_items WHERE source_id = 'e2eVid${String(n).padStart(5, '0')}'`);
	const sc = sql(`SELECT id FROM media_items WHERE source_id = '${SC_TRACK}'`);
	// Only the videos R5 uses (other specs rely on #6 staying non-embeddable).
	sql(`UPDATE media_items SET embeddable = true, unavailable = false WHERE source_id IN ('e2eVid00001','e2eVid00002','e2eVid00003','e2eVid00004','e2eVid00005')`);
	return { uris, yt, sc };
}

async function makeMix(request: Req, baseURL: string | undefined, name: string, items: { source: string; spotifyUri?: string; mediaItemId?: string }[]) {
	const { id } = await (await request.post('/api/mixes', { headers: origin(baseURL), data: { name } })).json();
	const r = await request.put(`/api/mixes/${id}`, { headers: origin(baseURL), data: { items } });
	expect(r.ok()).toBe(true);
	return id as string;
}

const optIn = (page: Page) => page.addInitScript(() => localStorage.setItem('rotor.mixedSessions', 'on'));
const S = (u: string) => ({ source: 'spotify', spotifyUri: u });
const Y = (id: string) => ({ source: 'youtube', mediaItemId: id });
const C = (id: string) => ({ source: 'soundcloud', mediaItemId: id });
const events = (sid: string) => sql(`SELECT string_agg(coalesce(from_source,'-') || '>' || coalesce(to_source,'-') || ':' || outcome, ' ' ORDER BY at, id) FROM handoff_events WHERE session_id = '${sid}'`);
const lastSession = (mix: string) => sql(`SELECT id FROM playback_sessions WHERE mix_id = '${mix}' ORDER BY started_at DESC LIMIT 1`);
const ytEnded = (page: Page) => page.evaluate(() => (window as unknown as { __yt: { ended(): void } }).__yt.ended());
const scFinish = (page: Page) => page.evaluate(() => (window as unknown as { __sc: { fire(e: string): void } }).__sc.fire('finish'));

test.describe('R5', () => {
	test.describe.configure({ timeout: 150_000 });

	test('R5-1 laptop mix S-S-YT-S-SC-S: "music would jump rooms" → Move Spotify here, every handoff ok, median gap ≤ 2 s @laptop', async ({ page, request, baseURL }) => {
		const { uris, yt, sc } = await setup(request, baseURL);
		const mix = await makeMix(request, baseURL, 'E2E laptop mix', [S(uris[0]!), S(uris[1]!), Y(yt(1)), S(uris[2]!), C(sc), S(uris[3]!)]);
		await mock.set({ devices: [IPHONE, SPEAKER, SDK], playback: { device_id: 'dev-iphone', is_playing: false, item_uri: uris[4], progress_ms: 0, context_uri: null } });
		await optIn(page);
		await page.goto(`/elsewhere/mix/${mix}`);
		await expect(page.locator('.strip .seg')).toHaveText(['Spotify', 'YouTube', 'Spotify', 'SoundCloud', 'Spotify']);
		await page.getByRole('button', { name: 'Start session' }).click();
		await expect(page.getByText(/Spotify is playing on iPhone\. YouTube would play here, so the music would jump rooms\./)).toBeVisible();
		await page.getByRole('button', { name: 'Move Spotify here' }).click();
		// Spotify part 1 (two short tracks) → YouTube.
		await expect(page.getByTestId('mix-yt').getByText('YouTube ▶ e2eVid00001')).toBeVisible({ timeout: 40_000 });
		await expect(page.locator('[data-phase="inapp"]')).toBeVisible();
		expect((await mock.state()).playback.is_playing).toBe(false); // nothing overlaps
		await ytEnded(page);
		// Spotify part 2 → SoundCloud (the widget loads the track and plays).
		await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __scLog?: string[] }).__scLog ?? [])).some((l) => l.startsWith('load:')), { timeout: 30_000 }).toBe(true);
		await expect(page.locator('[data-phase="inapp"]')).toBeVisible();
		expect((await mock.state()).playback.is_playing).toBe(false);
		await scFinish(page);
		// Spotify part 3 → end → summary.
		await expect(page.getByRole('region', { name: 'Session summary' })).toBeVisible({ timeout: 40_000 });
		const sid = lastSession(mix);
		expect(events(sid)).toBe('spotify>youtube:ok youtube>spotify:ok spotify>soundcloud:ok soundcloud>spotify:ok');
		const s = await (await request.get(`/api/mix-sessions/${sid}`)).json();
		expect(s.okHandoffs).toBe(4);
		expect(s.medianGapMs).toBeLessThanOrEqual(2000);
		await expect(page.getByText(/4 of 4 handoffs ok · median gap/)).toBeVisible();
	});

	test('R5-2 Spotify on a speaker: the start is blocked with the choice; Cancel plays nothing @laptop', async ({ page, request, baseURL }) => {
		const { uris, yt } = await setup(request, baseURL);
		const mix = await makeMix(request, baseURL, 'E2E speaker', [S(uris[0]!), Y(yt(1))]);
		await mock.set({ devices: [SPEAKER, SDK], playback: { device_id: 'dev-speaker', is_playing: true, item_uri: uris[4], progress_ms: 1000, context_uri: null } });
		await optIn(page);
		await page.goto(`/elsewhere/mix/${mix}`);
		await mock.resetCalls();
		await page.getByRole('button', { name: 'Start session' }).click();
		const dlg = page.getByRole('alertdialog', { name: 'Music would jump rooms' });
		await expect(dlg).toContainText('Spotify is playing on Living room');
		await expect(dlg.getByRole('button')).toHaveText(['Move Spotify here', 'Skip YouTube items', 'Cancel']);
		await dlg.getByRole('button', { name: 'Cancel' }).click();
		expect((await mock.writes()).filter((c) => c.path === '/v1/me/player/play')).toEqual([]);
		expect(sqlNum(`SELECT count(*) FROM playback_sessions WHERE mix_id = '${mix}'`)).toBe(0);
	});

	test('R5-3 skipping a track in the Spotify app pauses the mix; Resume carries on @laptop', async ({ page, request, baseURL }) => {
		const { uris, yt } = await setup(request, baseURL, 9000);
		const mix = await makeMix(request, baseURL, 'E2E diverge', [S(uris[0]!), S(uris[1]!), S(uris[2]!), Y(yt(1))]);
		await mock.set({ devices: [{ ...SDK, is_active: true }], playback: { device_id: 'dev-laptop-sdk', is_playing: false, item_uri: uris[4], progress_ms: 0, context_uri: null } });
		await optIn(page);
		await page.goto(`/elsewhere/mix/${mix}`);
		await page.getByRole('button', { name: 'Start session' }).click();
		if (await page.getByRole('button', { name: 'Move Spotify here' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Move Spotify here' }).click();
		await expect.poll(async () => (await mock.state()).playback?.item_uri, { timeout: 15_000 }).toBe(uris[0]);
		await page.waitForTimeout(2000);
		// The user presses Next in the Spotify app, 2 s into a 9 s track.
		const pb = (await mock.state()).playback;
		await mock.set({ playback: { ...pb, index: 1, item_uri: uris[1], progress_ms: 0, since: Date.now() } });
		await expect(page.getByText('Mix paused — you’re playing something else in Spotify.')).toBeVisible({ timeout: 10_000 });
		const sid = lastSession(mix);
		expect(events(sid)).toContain('spotify>-:diverged');
		await page.getByRole('button', { name: 'Resume mix' }).click();
		await expect(page.getByText('Mix paused')).toHaveCount(0);
		await expect.poll(async () => (await mock.state()).playback?.is_playing).toBe(true);
		await page.getByRole('button', { name: 'End session' }).click();
	});

	test('R5-4 Spotify autoplay after the run is paused within one poll, with the hint @laptop', async ({ page, request, baseURL }) => {
		const { uris, yt } = await setup(request, baseURL);
		const mix = await makeMix(request, baseURL, 'E2E autoplay', [S(uris[0]!), Y(yt(2))]);
		await mock.set({ autoplay: true, autoplayUri: uris[4], devices: [{ ...SDK, is_active: true }], playback: { device_id: 'dev-laptop-sdk', is_playing: false, item_uri: uris[3], progress_ms: 0, context_uri: null } });
		const st = await mock.state();
		await mock.set({ tracks: { ...st.tracks, [uris[4]!]: { ...st.tracks[uris[4]!], duration_ms: 240_000 } } });
		await optIn(page);
		await page.goto(`/elsewhere/mix/${mix}`);
		await page.getByRole('button', { name: 'Start session' }).click();
		if (await page.getByRole('button', { name: 'Move Spotify here' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Move Spotify here' }).click();
		await expect(page.getByText(/Spotify autoplay was on for this device/)).toBeVisible({ timeout: 30_000 });
		await expect.poll(async () => (await mock.state()).playback.is_playing, { timeout: 5_000 }).toBe(false);
		await expect(page.getByTestId('mix-yt').getByText('YouTube ▶ e2eVid00002')).toBeVisible();
		expect(events(lastSession(mix))).toContain('spotify>-:spotify_autoplay');
		await mock.set({ autoplay: false });
		await page.getByRole('button', { name: 'End session' }).click();
	});

	test('R5-5 a refused embed is skipped; blocked autoplay shows "Tap to continue" @laptop', async ({ page, request, baseURL }) => {
		const { uris, yt } = await setup(request, baseURL);
		const mix = await makeMix(request, baseURL, 'E2E failures', [S(uris[0]!), Y(yt(3)), Y(yt(4))]);
		await mock.set({ devices: [{ ...SDK, is_active: true }], playback: { device_id: 'dev-laptop-sdk', is_playing: false, item_uri: uris[3], progress_ms: 0, context_uri: null } });
		await optIn(page);
		await page.addInitScript(() => {
			(window as unknown as { __ytRefuse: string[] }).__ytRefuse = ['e2eVid00003'];
			(window as unknown as { __ytBlockAutoplay: boolean }).__ytBlockAutoplay = true;
		});
		await page.goto(`/elsewhere/mix/${mix}`);
		await page.getByRole('button', { name: 'Start session' }).click();
		if (await page.getByRole('button', { name: 'Move Spotify here' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Move Spotify here' }).click();
		await expect(page.getByText(/Tap to continue on YouTube/)).toBeVisible({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page.getByText(/Skipped “E2E video 3” — the uploader doesn’t allow embedding/)).toBeVisible();
		// #4 is next; its first autoplay is blocked too → tap again → it plays.
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page.getByTestId('mix-yt').getByText('YouTube ▶ e2eVid00004')).toBeVisible();
		const ev = events(lastSession(mix));
		expect(ev).toContain(':autoplay_blocked');
		expect(ev).toContain('youtube:not_embeddable');
		await page.getByRole('button', { name: 'End session' }).click();
	});

	test('R5-6 iPhone relay: when the page is gone, a push says "tap to continue"; opening it shows the tap card @mobile', async ({ page, request, baseURL, context }) => {
		const { uris, yt } = await setup(request, baseURL);
		const mix = await makeMix(request, baseURL, 'E2E relay', [S(uris[0]!), Y(yt(5))]);
		await mock.set({ devices: [IPHONE], playback: { device_id: 'dev-iphone', is_playing: false, item_uri: uris[3], progress_ms: 0, context_uri: null } });
		const pushesBefore = (await mock.pushes()).length;
		await optIn(page);
		await page.goto(`/elsewhere/mix/${mix}`);
		await page.getByRole('button', { name: 'Start session' }).click();
		await expect.poll(async () => (await mock.state()).playback?.item_uri, { timeout: 15_000 }).toBe(uris[0]);
		await expect.poll(() => sql(`SELECT status FROM hub_jobs WHERE kind = 'mix_relay' ORDER BY requested_at DESC LIMIT 1`), { timeout: 15_000 }).toMatch(/queued|running/);
		// The phone locks: the page stops running (here: it's closed).
		await page.close();
		await expect.poll(async () => (await mock.pushes()).slice(pushesBefore).find((p) => p.data.kind === 'mix_relay')?.data.body, { timeout: 60_000 }).toBe('Spotify part finished — tap to continue on YouTube');
		const push = (await mock.pushes()).slice(pushesBefore).find((p) => p.data.kind === 'mix_relay')!;
		const p2 = await context.newPage();
		await p2.addInitScript(() => localStorage.setItem('rotor.mixedSessions', 'on'));
		await p2.goto(push.data.url);
		await expect(p2.getByText('Tap to continue on YouTube')).toBeVisible();
		await p2.getByRole('button', { name: 'Continue' }).click();
		await expect(p2.getByTestId('mix-yt').getByText('YouTube ▶ e2eVid00005')).toBeVisible();
		await expect(p2.getByTestId('mix-yt')).toBeVisible();
		expect(events(lastSession(mix))).toContain('spotify>youtube:relay');
	});

	test('R5-7 opt-in off: no mix UI anywhere; turning it on needs the policy warning @both', async ({ page, request, baseURL }) => {
		const mix = await makeMix(request, baseURL, 'E2E hidden', []);
		await page.goto('/elsewhere');
		await expect(page.getByRole('link', { name: 'Mixes' })).toHaveCount(0);
		await page.goto('/elsewhere/mix');
		await expect(page.getByText(/Mixed sessions are off on this device/)).toBeVisible();
		await expect(page.getByRole('button', { name: 'Create mix' })).toHaveCount(0);
		await page.goto(`/elsewhere/mix/${mix}`);
		await expect(page.getByRole('button', { name: 'Start session' })).toHaveCount(0);
		await page.goto('/settings');
		let warned = '';
		page.once('dialog', (d) => ((warned = d.message()), d.accept()));
		await page.getByRole('button', { name: 'Turn on for this device…' }).click();
		expect(warned).toMatch(/conflicts with Spotify’s Developer Policy \(III\.5, III\.7\)/);
		await page.goto('/elsewhere');
		await expect(page.getByRole('link', { name: 'Mixes' })).toBeVisible();
	});

	test('R5-8 Spotify items in a mix are text + badge only; mixes never appear in Spotify lists @laptop', async ({ page, request, baseURL }) => {
		const { uris, yt } = await setup(request, baseURL);
		const mix = await makeMix(request, baseURL, 'E2E visible', [S(uris[0]!), Y(yt(1))]);
		await optIn(page);
		await page.goto(`/elsewhere/mix/${mix}`);
		const row = page.locator('ol.items li').first();
		await expect(row.locator('.src')).toHaveText('Spotify');
		await expect(row.locator('img')).toHaveCount(0);
		for (const p of ['/library', '/search?q=E2E', '/home']) {
			await page.goto(p);
			await expect(page.getByText('E2E visible')).toHaveCount(0);
		}
	});
});
