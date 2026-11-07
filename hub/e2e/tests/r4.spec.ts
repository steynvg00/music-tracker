/** R4: Elsewhere — YouTube/SoundCloud collections in their own room with their own visible players. */
import { execFileSync } from 'node:child_process';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const YT_LIST = 'https://www.youtube.com/playlist?list=PLe2eRotorTestList01';
const SC_SET = 'https://soundcloud.com/e2e-artist/sets/e2e-set';
const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const ytCalls = async () => (await mock.calls()).filter((c) => c.host === 'www.googleapis.com');

/** Make sure a collection exists (mobile tests run before the laptop import test). */
async function ensure(request: import('@playwright/test').APIRequestContext, baseURL: string | undefined, url: string): Promise<string> {
	const source = url.includes('soundcloud') ? 'soundcloud' : 'youtube';
	const have = sql(`SELECT id FROM collections WHERE source = '${source}' LIMIT 1`);
	if (have) return have;
	const r = await request.post('/api/collections', { headers: origin(baseURL), data: { url } });
	expect(r.status()).toBe(201);
	return (await r.json()).collection.id;
}
const playBtn = (page: import('@playwright/test').Page) => page.locator('.hd').getByRole('button', { name: /^(Play|Pause)$/ });

async function importLink(page: import('@playwright/test').Page, source: 'youtube' | 'soundcloud', link: string) {
	await page.goto(`/library?source=${source}`);
	await page.getByLabel(source === 'youtube' ? 'YouTube link' : 'SoundCloud link').fill(link);
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await expect(page).toHaveURL(/\/elsewhere\/[0-9a-f-]{36}/, { timeout: 15_000 });
	return page.url().split('/elsewhere/')[1]!;
}

test.describe('R4', () => {
	test('R4-1 Library source switch is exclusive (no "All") and remembered @both', async ({ page }) => {
		await page.goto('/library');
		// v0.91: the source is a pill group in the one filter bar.
		const sources = page.getByTestId('lib-pills').locator('[data-group=source]');
		await expect(sources).toHaveText(['Spotify', 'YouTube', 'SoundCloud']);
		await expect(page.getByText('Top 30 last 30 days · Auto 🤖🔄').filter({ visible: true }).first()).toBeVisible();
		await sources.filter({ hasText: 'YouTube' }).click();
		await expect(page.getByLabel('YouTube link')).toBeVisible();
		await expect(page.locator('main, .view').getByText('Top 30 last 30 days · Auto 🤖🔄')).toHaveCount(0);
		await page.goto('/library');
		await expect(page.getByTestId('lib-pills').locator('[data-group=source][aria-pressed=true]')).toHaveText('YouTube');
		await page.getByTestId('pill-clear').click();
		await expect(page.getByText('Top 30 last 30 days · Auto 🤖🔄').filter({ visible: true }).first()).toBeVisible();
	});

	test('R4-2 import an unlisted YouTube playlist: 22 playable items listed, 3 quota units @laptop', async ({ page }) => {
		sql(`DELETE FROM collections WHERE source = 'youtube'`);
		await mock.resetCalls();
		const id = await importLink(page, 'youtube', YT_LIST);
		await expect(page.getByRole('heading', { name: 'E2E hardstyle mix' })).toBeVisible();
		await expect(page.locator('ol.items li')).toHaveCount(22); // the deleted 23rd video is left out
		await expect(page.locator('ol.items li.off')).toHaveCount(1); // #6 isn't embeddable
		await expect(page.locator('ol.items').getByText('Can’t play here')).toHaveCount(1);
		await expect(page.locator('.hd').getByText(/3 quota units/)).toBeVisible();
		expect((await ytCalls()).length).toBeLessThan(5);
		expect(sqlNum(`SELECT item_count FROM collections WHERE id = '${id}'`)).toBe(22);
	});

	test('R4-3 laptop: visible YouTube player ≥ 480×270; ENDED advances; a refused embed is skipped with a notice @laptop', async ({ page, request, baseURL }) => {
		const id = await ensure(request, baseURL, YT_LIST);
		sql(`UPDATE media_items SET embeddable = true WHERE source_id = 'e2eVid00003'`);
		await page.addInitScript(() => ((window as unknown as { __ytRefuse: string[] }).__ytRefuse = ['e2eVid00003']));
		await page.goto(`/elsewhere/${id}`);
		const frame = page.getByTestId('elsewhere-player');
		await expect(frame).toBeVisible();
		const box = (await frame.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(480);
		expect(box.height).toBeGreaterThanOrEqual(270);
		await playBtn(page).click();
		await expect(frame.getByText('YouTube ▶ e2eVid00001')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __yt: { ended(): void } }).__yt.ended());
		await expect(frame.getByText('YouTube ▶ e2eVid00002')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __yt: { ended(): void } }).__yt.ended());
		// #3 answers error 150 at play time → flagged, notice, and the player moves on to #4.
		await expect(page.getByText(/Skipped “E2E video 3” — the uploader doesn’t allow embedding/)).toBeVisible();
		await expect(frame.getByText('YouTube ▶ e2eVid00004')).toBeVisible();
		await expect.poll(() => sql(`SELECT embeddable FROM media_items WHERE source_id = 'e2eVid00003'`)).toBe('f');
		// #6 was flagged at import: Next from #5 jumps straight to #7.
		await page.locator('ol.items li').nth(4).getByRole('button').click();
		await expect(frame.getByText('YouTube ▶ e2eVid00005')).toBeVisible();
		await page.locator('.ctl').getByRole('button', { name: /Next/ }).click();
		await expect(frame.getByText('YouTube ▶ e2eVid00007')).toBeVisible();
	});

	test('R4-4 mobile: Play opens a full-screen player sheet (≥ 200×200); closing it pauses — no hidden player @mobile', async ({ page, request, baseURL }) => {
		const id = await ensure(request, baseURL, YT_LIST);
		await page.goto(`/elsewhere/${id}`);
		const stage = page.locator('aside.stage');
		await expect(stage).toHaveAttribute('aria-hidden', 'true');
		await playBtn(page).click();
		await expect(stage).toHaveAttribute('aria-hidden', 'false');
		const box = (await page.getByTestId('elsewhere-player').boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(200);
		expect(box.height).toBeGreaterThanOrEqual(200);
		await expect(page.getByTestId('elsewhere-player').getByText(/YouTube ▶ e2eVid/)).toBeVisible();
		await page.getByRole('button', { name: 'Close player' }).click();
		const log = await page.evaluate(() => (window as unknown as { __ytLog: string[] }).__ytLog);
		expect(log.at(-1)).toBe('pause');
		await expect(stage).toHaveAttribute('aria-hidden', 'true');
	});

	test('R4-5 SoundCloud set via oEmbed: the widget plays it, Go+ previews are skipped, Next moves within the set @laptop', async ({ page }) => {
		sql(`DELETE FROM collections WHERE source = 'soundcloud'`);
		const id = await importLink(page, 'soundcloud', SC_SET);
		await expect(page.getByRole('heading', { name: 'E2E SoundCloud set' })).toBeVisible();
		const frame = page.frameLocator('iframe[title="SoundCloud player"]');
		await expect(frame.getByText('SoundCloud widget (E2E stub)')).toBeVisible();
		await page.evaluate(() => ((window as unknown as { __sc: unknown }).__sc = { sounds: [{ title: 'Go plus track', policy: 'SNIP' }, { title: 'Full track' }, { title: 'Third' }], index: 0 }));
		await playBtn(page).click();
		await expect(page.getByText(/Skipped “Go plus track” — Go\+ tracks only play a 30-second preview here/)).toBeVisible();
		await page.locator('.ctl').getByRole('button', { name: /Next/ }).click();
		const log = await page.evaluate(() => (window as unknown as { __scLog: string[] }).__scLog);
		expect(log).toEqual(['play:0', 'next:1', 'next:2']);
		expect(sql(`SELECT kind FROM collections WHERE id = '${id}'`)).toBe('set');
	});

	test('R4-6 separate rooms: no YouTube/SoundCloud item in Spotify lists, search or Home; Home has only the link card @both', async ({ page, request, baseURL }) => {
		await ensure(request, baseURL, YT_LIST);
		await ensure(request, baseURL, SC_SET);
		const n = sqlNum('SELECT count(*) FROM collections');
		await page.goto('/home');
		const card = page.locator('a.elsewhere');
		await expect(card).toBeVisible();
		await expect(card).toContainText(`${n} YouTube & SoundCloud collection`);
		await expect(card.locator('img')).toHaveCount(0);
		await expect(page.getByText(/E2E video|E2E hardstyle mix|E2E SoundCloud set/)).toHaveCount(0);
		await page.goto('/library?source=spotify');
		await expect(page.getByText(/E2E video|E2E hardstyle mix|E2E SoundCloud set/)).toHaveCount(0);
		await page.goto('/search?q=E2E');
		await expect(page.getByText(/E2E video|E2E hardstyle mix|E2E SoundCloud set/)).toHaveCount(0);
		await page.goto('/stats/top');
		await expect(page.getByText(/E2E video/)).toHaveCount(0);
	});

	test('R4-7 30-day rule: stale items are refreshed by the daily run, and deleted when they can’t be @laptop', async () => {
		sql(`UPDATE media_items SET last_checked_at = now() - interval '31 days' WHERE source = 'youtube'`);
		sql(`UPDATE collections SET last_synced_at = now() - interval '26 days'`);
		await mock.resetCalls();
		const env = { ...process.env, E2E_SPOTIFY_PREFIX: 'http://127.0.0.1:55433/v1/' };
		execFileSync('uv', ['run', '--no-sync', 'python', 'hub/e2e/run_job_mocked.py', '--daily'], { cwd: REPO, env, encoding: 'utf8' });
		expect(sqlNum(`SELECT count(*) FROM media_items WHERE source = 'youtube' AND last_checked_at < now() - interval '1 day'`)).toBe(0);
		expect((await mock.calls()).filter((c) => c.who === 'python' && c.host === 'www.googleapis.com').length).toBeGreaterThan(0);
		expect(sql(`SELECT bool_and(last_synced_at > now() - interval '1 day') FROM collections`)).toBe('t');
		// Without a key the data can't be refreshed: past 30 days it is deleted, never kept.
		sql(`UPDATE media_items SET last_checked_at = now() - interval '31 days' WHERE source = 'youtube'`);
		execFileSync('uv', ['run', '--no-sync', 'python', '-c', 'import psycopg,sys; from lib.collections_refresh import refresh; print(refresh(psycopg.connect(sys.argv[1]), key=""))', process.env.E2E_DB!], { cwd: REPO, encoding: 'utf8' });
		expect(sqlNum(`SELECT count(*) FROM media_items WHERE source = 'youtube'`)).toBe(0);
		expect(sqlNum(`SELECT item_count FROM collections WHERE source = 'youtube'`)).toBe(0);
	});

	test('R4-8 bad links are refused with a reason; Settings shows the YouTube key status @laptop', async ({ page, request, baseURL }) => {
		for (const url of ['https://www.youtube.com/playlist?list=LL', 'https://on.soundcloud.com/abc', 'https://vimeo.com/1', 'https://soundcloud.com/x/likes']) {
			const r = await request.post('/api/collections', { headers: origin(baseURL), data: { url } });
			expect(r.status(), url).toBe(400);
		}
		await page.goto('/settings');
		await expect(page.getByText(/API key configured/)).toBeVisible();
		await expect(page.getByText(/SoundCloud:.*no key needed/)).toBeVisible();
	});

	test('R4-9 removing a collection removes only Rotor’s copy (no external writes) @laptop', async ({ request, baseURL }) => {
		const id = sql(`SELECT id FROM collections WHERE source = 'soundcloud' LIMIT 1`);
		await mock.resetCalls();
		const r = await request.delete(`/api/collections/${id}`, { headers: origin(baseURL) });
		expect(r.ok()).toBe(true);
		expect(sqlNum(`SELECT count(*) FROM collections WHERE id = '${id}'`)).toBe(0);
		expect((await mock.calls()).filter((c) => c.method !== 'GET')).toEqual([]);
	});

	test('R4-10 nothing leaves localhost from the Elsewhere pages (players are stubbed) @both', async ({ page, blocked }) => {
		for (const p of ['/elsewhere', '/elsewhere?source=soundcloud', '/library?source=youtube']) await page.goto(p);
		expect(blocked).toEqual([]);
		expect((await mock.calls()).filter((c) => c.blocked || c.unmocked)).toEqual([]);
	});
});
