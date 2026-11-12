/**
 * v0.91: one pill bar in Library and Stats, Rotor-only pins + folders + custom order (0034),
 * Manage mode, and not a single Spotify write from any of it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const OUT = process.env.E2E_OUT ?? 'e2e/.out';
const key = (id: string) => `spotify:playlist:${id}`;
const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const entry = (page: Page, k: string) => page.locator(`[data-testid=entry][data-key="${k}"]`);
const pinnedKeys = (page: Page) => page.getByTestId('pinned').locator('[data-testid=entry]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key!));
function resetOrganiser() {
	sql(`DELETE FROM library_items; DELETE FROM library_folders`);
}
async function openLibrary(page: Page) {
	await page.goto('/library');
	await expect(page.locator('[data-testid=entries] [data-testid=entry]').first()).toBeVisible();
	// v0.92: the list is server-rendered; the pills only appear once the page is hydrated (interactive).
	await expect(page.getByTestId('lib-pills').locator('[data-testid=pill]').first()).toBeVisible();
}
async function select(page: Page, keys: string[]) {
	for (const k of keys) await entry(page, k).getByRole('checkbox').click();
}
async function dragMouse(page: Page, handle: Locator, target: Locator) {
	const a = (await handle.boundingBox())!;
	const b = (await target.boundingBox())!;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + ((b.y + 4 - (a.y + a.height / 2)) * i) / 8);
	await page.mouse.up();
}

/** CLS of the page's first load (no input), after it has settled (same observer as R8-6). */
async function settledCls(page: Page, path: string, ready: (p: Page) => Promise<void>): Promise<number> {
	await page.addInitScript(() => {
		const w = window as unknown as { __cls: number; __clsOn?: boolean };
		if (w.__clsOn) return;
		w.__clsOn = true;
		w.__cls = 0;
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value;
		}).observe({ type: 'layout-shift', buffered: true });
	});
	await page.goto(path);
	await ready(page);
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(500);
	return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

test.describe('v0.91 one filter bar', () => {
	test('V091-1 Library: one scrollable pill bar; a kind pill filters, collapses its group and shows ×; remembered @both', async ({ page }) => {
		resetOrganiser();
		await openLibrary(page);
		const bar = page.getByTestId('lib-pills');
		expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(46); // one row
		await expect(bar.locator('[data-testid=pill]')).toHaveText(['Spotify', 'YouTube', 'SoundCloud', 'Managed 🔄', 'Snapshots 📸', 'Custom 🎧', 'Rules-based', 'Followed', 'Pinned', 'Folders']);
		await expect(bar).toHaveCSS('overflow-x', 'visible'); // the inner row scrolls, not the page
		await expect(bar.locator('.scroll')).toHaveCSS('overflow-x', 'auto');
		// The old stacked rows are gone from the Library.
		for (const name of ['Rules', 'Release radar', 'This week']) await expect(page.locator('.view').getByRole('link', { name, exact: true })).toHaveCount(0);
		await expect(page.getByTestId('library').getByRole('combobox')).toHaveCount(0); // no sort dropdown row
		await bar.locator('[data-testid=pill]', { hasText: 'Custom 🎧' }).click();
		await expect(page.getByTestId('pill-clear')).toBeVisible();
		await expect(bar.locator('[data-group=kind]')).toHaveText(['Custom 🎧']); // the other kinds collapse
		const custom = sql(`SELECT string_agg('spotify:playlist:' || playlist_id, ',' ORDER BY playlist_id) FROM spotify_playlists WHERE managed_kind = 'custom' AND removed_at IS NULL`).split(',');
		const shown = await page.locator('[data-testid=entries] [data-testid=entry]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key!));
		expect(shown.sort()).toEqual(custom.sort());
		await page.reload();
		await expect(bar.locator('[data-group=kind][aria-pressed=true]')).toHaveText('Custom 🎧');
		await page.getByTestId('pill-clear').click();
		await expect(page.getByTestId('pill-clear')).toHaveCount(0);
		await expect(bar.locator('[data-group=kind]')).toHaveCount(7);
	});

	test('V091-2 Library: sort & view sheet (A–Z, recently played, recently added, track count, custom order; list / grid) @laptop', async ({ page }) => {
		resetOrganiser();
		await openLibrary(page);
		await page.getByTestId('pill-action').click();
		const sorts = page.getByTestId('sheet-sort').getByRole('radio');
		await expect(sorts).toHaveText(['A–Z', 'Recently played', 'Recently added', 'Track count', 'Custom order']);
		await sorts.filter({ hasText: 'Track count' }).click();
		const counts = await page.locator('[data-testid=entries] [data-type=playlist] .m').evaluateAll((els) => els.map((e) => Number((/(\d+) tracks/.exec(e.textContent ?? '') ?? [, '-1'])[1])));
		expect(counts).toEqual([...counts].sort((a, b) => b - a));
		await page.getByTestId('pill-action').click();
		await page.getByTestId('sheet-view').getByRole('radio', { name: 'Grid' }).click();
		await expect(page.locator('[data-testid=entries].grid')).toBeVisible();
		await page.getByTestId('pill-action').click();
		await page.getByTestId('sheet-view').getByRole('radio', { name: 'List' }).click();
		await page.getByTestId('pill-action').click();
		await page.getByTestId('sheet-sort').getByRole('radio', { name: 'A–Z' }).click();
		await expect(page.locator('[data-testid=entries].list')).toBeVisible();
	});

	test('V091-3 Library search is one tap away and filters as you type (also inside folders) @both', async ({ page, request, baseURL }) => {
		resetOrganiser();
		const f = await mock.fixture();
		const folder = (await (await request.post('/api/library/folders', { headers: origin(baseURL), data: { name: 'E2E Search folder' } })).json()).folder.id;
		await request.post('/api/library/move', { headers: origin(baseURL), data: { keys: [key(f.road)], folderId: folder } });
		await openLibrary(page);
		await expect(entry(page, key(f.road))).toHaveCount(0); // inside the folder
		await page.getByTestId('lib-search-toggle').click();
		await page.getByTestId('lib-q').fill('road tr');
		await expect(page.locator('[data-testid=entry]')).toHaveCount(1);
		await expect(entry(page, key(f.road))).toBeVisible();
		await page.getByTestId('lib-q').fill('search fold');
		await expect(entry(page, `folder:${folder}`)).toBeVisible();
	});

	test('V091-4 Stats: the same pill bar (section menu, list, period, ×, Rank by sheet); no second row @both', async ({ page }) => {
		await page.goto('/stats/top');
		const bar = page.getByTestId('stats-pills');
		await expect(page.locator('nav.sn')).toHaveCount(0); // the old section row
		await expect(bar.getByTestId('pill-menu-section')).toHaveText(/Top/);
		await expect(bar.locator('[data-group=view][aria-pressed=true]')).toHaveText('Tracks');
		await expect(page.getByTestId('pill-clear')).toHaveCount(0);
		await bar.getByRole('button', { name: 'This year', exact: true }).click();
		await expect(page).toHaveURL(/range=this_year/);
		await expect(page.getByTestId('pill-clear')).toBeVisible();
		await page.getByTestId('pill-clear').click();
		await expect(page).not.toHaveURL(/range=/);
		await expect(bar.locator('[data-group=view][aria-pressed=true]')).toHaveText('Tracks'); // the list stays
		await bar.getByTestId('pill-menu-year').click();
		await page.getByTestId('sheet-year').getByRole('radio').nth(1).click();
		await expect(page).toHaveURL(/range=year-\d{4}/);
		await bar.getByTestId('pill-menu-section').click();
		await page.getByTestId('sheet-section').getByRole('radio', { name: 'Patterns' }).click();
		await expect(page).toHaveURL(/\/stats\/patterns$/);
		await expect(page.getByTestId('stats-pills').getByTestId('pill-menu-year')).toBeVisible();
		await page.goto('/stats/compare');
		await page.getByTestId('stats-pills').getByRole('button', { name: 'Month', exact: true }).click();
		await expect(page).toHaveURL(/mode=month/);
	});

	test('V091-5 no layout shift on first load: Library and Stats (CLS < 0.01) @both', async ({ page }, info) => {
		resetOrganiser();
		const lib = await settledCls(page, '/library', async (p) => {
			await expect(p.locator('[data-testid=entries] [data-testid=entry]').first()).toBeVisible();
		});
		const stats = await settledCls(page, '/stats', async (p) => {
			await expect(p.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();
		});
		const top = await settledCls(page, '/stats/top', async (p) => {
			await expect(p.getByRole('heading', { name: /Top 50 tracks/ })).toBeVisible();
		});
		console.log(`[perf] v0.91 CLS ${info.project.name} library=${lib.toFixed(4)} stats=${stats.toFixed(4)} top=${top.toFixed(4)}`);
		writeFileSync(join(OUT, `cls-v091-${info.project.name}.json`), JSON.stringify({ library: lib, stats, top }));
		expect(lib).toBeLessThan(0.01);
		expect(stats).toBeLessThan(0.01);
		expect(top).toBeLessThan(0.01);
	});
});

test.describe('v0.91 pins, folders, Manage', () => {
	test('V091-6 pin in Manage mode (Rotor-only note), drag to reorder on the laptop, order persists @laptop', async ({ page }) => {
		resetOrganiser();
		const f = await mock.fixture();
		const keys = [key(f.top30), key(f.road), key(f.followed)];
		await openLibrary(page);
		await page.getByTestId('lib-manage').click();
		await expect(page.getByTestId('rotor-only')).toContainText('Rotor only');
		await select(page, keys);
		await page.getByTestId('m-pin').click();
		await expect(page.getByTestId('pinned')).toBeVisible();
		await page.getByTestId('lib-manage').click(); // Done
		expect(await pinnedKeys(page)).toEqual(keys);
		// Drag the third pin to the top by its handle (selecting rows may have scrolled the page).
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.getByTestId('pinned').scrollIntoViewIfNeeded();
		await dragMouse(page, entry(page, keys[2]!).locator('[data-sort-handle]'), entry(page, keys[0]!));
		await expect.poll(() => pinnedKeys(page)).toEqual([keys[2], keys[0], keys[1]]);
		expect(sql(`SELECT string_agg(item_key, ',' ORDER BY pin_pos) FROM library_items WHERE pin_pos IS NOT NULL`)).toBe([keys[2], keys[0], keys[1]].join(','));
		await page.reload();
		await expect.poll(() => pinnedKeys(page)).toEqual([keys[2], keys[0], keys[1]]);
		// Pinned items aren't listed twice.
		await expect(page.getByTestId('entries').locator(`[data-key="${keys[0]}"]`)).toHaveCount(0);
		// Keyboard: ArrowDown on a handle moves it one down.
		await entry(page, keys[2]!).locator('[data-sort-handle]').focus();
		await page.keyboard.press('ArrowDown');
		await expect.poll(() => pinnedKeys(page)).toEqual([keys[0], keys[2], keys[1]]);
	});

	test('V091-7 iPhone: long-press + drag reorders the pins @mobile', async ({ page, request, baseURL }) => {
		resetOrganiser();
		const f = await mock.fixture();
		const keys = [key(f.top30), key(f.road), key(f.custom)];
		await request.post('/api/library/pin', { headers: origin(baseURL), data: { targets: keys, pinned: true } });
		await openLibrary(page);
		expect(await pinnedKeys(page)).toEqual(keys);
		const from = (await entry(page, keys[2]!).boundingBox())!;
		const to = (await entry(page, keys[0]!).boundingBox())!;
		// Touch pointer events as iOS sends them: down, hold 450 ms, move, up.
		await page.evaluate(
			async ({ k, x, y0, y1 }) => {
				const el = document.querySelector(`[data-testid=entry][data-key="${k}"] .main`)!;
				const fire = (type: string, y: number) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y }));
				fire('pointerdown', y0);
				await new Promise((r) => setTimeout(r, 450));
				for (let i = 1; i <= 6; i++) fire('pointermove', y0 + ((y1 - y0) * i) / 6);
				fire('pointerup', y1);
			},
			{ k: keys[2]!, x: from.x + from.width / 2, y0: from.y + from.height / 2, y1: to.y + 4 }
		);
		await expect.poll(() => pinnedKeys(page)).toEqual([keys[2], keys[0], keys[1]]);
		await expect.poll(() => sql(`SELECT string_agg(item_key, ',' ORDER BY pin_pos) FROM library_items WHERE pin_pos IS NOT NULL`)).toBe([keys[2], keys[0], keys[1]].join(','));
		await page.reload();
		await expect.poll(() => pinnedKeys(page)).toEqual([keys[2], keys[0], keys[1]]);
		await expect(page).toHaveURL(/\/library$/); // the long-press didn't open the playlist
	});

	test('V091-8 folders: create, move in (multi-select), nest one level, refuse a second level, rename, pin, delete → back to the root @laptop', async ({ page, request, baseURL }) => {
		resetOrganiser();
		const f = await mock.fixture();
		const playlists0 = sqlNum(`SELECT count(*) FROM spotify_playlists WHERE removed_at IS NULL`);
		await openLibrary(page);
		await page.getByTestId('lib-plus').click();
		await page.getByTestId('plus-folder').click();
		await page.getByTestId('folder-name-input').fill('E2E Gym');
		await page.getByTestId('folder-save').click();
		const gym = sqlNum(`SELECT id FROM library_folders WHERE name = 'E2E Gym'`);
		await expect(entry(page, `folder:${gym}`)).toBeVisible();
		// Multi-select two playlists → Move to folder → E2E Gym.
		await page.getByTestId('lib-manage').click();
		await select(page, [key(f.road), key(f.custom)]);
		await page.getByTestId('m-move').click();
		await page.locator(`[data-testid=move-to][data-folder="${gym}"]`).click();
		await expect(entry(page, key(f.road))).toHaveCount(0);
		await page.getByTestId('lib-manage').click();
		await entry(page, `folder:${gym}`).locator('a.main').click();
		await expect(page).toHaveURL(new RegExp(`folder=${gym}`));
		await expect(page.getByTestId('folder-name')).toHaveText('E2E Gym');
		await expect(entry(page, key(f.road))).toBeVisible();
		await expect(entry(page, key(f.custom))).toBeVisible();
		// A subfolder (one level): created from inside the folder, parent preselected.
		await page.getByTestId('lib-plus').click();
		await page.getByTestId('plus-folder').click();
		await page.getByTestId('folder-name-input').fill('E2E Cardio');
		await page.getByTestId('folder-save').click();
		const cardio = sqlNum(`SELECT id FROM library_folders WHERE name = 'E2E Cardio'`);
		expect(sqlNum(`SELECT parent_id FROM library_folders WHERE id = ${cardio}`)).toBe(gym);
		await expect(entry(page, `folder:${cardio}`)).toBeVisible();
		// A second level is refused (API + trigger), and so is moving a parent into its child.
		const deep = await request.post('/api/library/folders', { headers: origin(baseURL), data: { name: 'Too deep', parentId: cardio } });
		expect(deep.status()).toBe(400);
		expect((await deep.json()).message).toMatch(/one level/);
		const loop = await request.patch(`/api/library/folders/${gym}`, { headers: origin(baseURL), data: { parentId: cardio } });
		expect(loop.status()).toBe(400);
		// A playlist is in one folder: moving it again moves it.
		await request.post('/api/library/move', { headers: origin(baseURL), data: { keys: [key(f.road)], folderId: cardio } });
		expect(sqlNum(`SELECT count(*) FROM library_items WHERE item_key = '${key(f.road)}'`)).toBe(1);
		expect(sqlNum(`SELECT folder_id FROM library_items WHERE item_key = '${key(f.road)}'`)).toBe(cardio);
		// Rename.
		await page.getByTestId('folder-rename').click();
		await page.getByTestId('folder-name-input').fill('E2E Gym 2');
		await page.getByTestId('folder-save').click();
		await expect(page.getByTestId('folder-name')).toHaveText('E2E Gym 2');
		// Pin the folder.
		await page.goto('/library');
		await page.getByTestId('lib-manage').click();
		await select(page, [`folder:${gym}`]);
		await page.getByTestId('m-pin').click();
		await expect(page.getByTestId('pinned').locator(`[data-key="folder:${gym}"]`)).toBeVisible();
		await page.getByTestId('lib-manage').click();
		// Delete: playlists + subfolder back to the root; no playlist deleted anywhere.
		await page.goto(`/library?folder=${gym}`);
		await page.getByTestId('folder-delete').click();
		await page.getByTestId('folder-delete-confirm').click();
		await expect(page).toHaveURL(/\/library$/);
		await expect(entry(page, key(f.custom))).toBeVisible();
		await expect(entry(page, `folder:${cardio}`)).toBeVisible();
		expect(sql(`SELECT parent_id IS NULL FROM library_folders WHERE id = ${cardio}`)).toBe('t');
		expect(sqlNum(`SELECT count(*) FROM library_folders WHERE id = ${gym}`)).toBe(0);
		expect(sqlNum(`SELECT count(*) FROM spotify_playlists WHERE removed_at IS NULL`)).toBe(playlists0);
		expect((await mock.state()).library).toContain(f.custom);
	});

	test('V091-9 Manage: only Custom 🎧 playlists get extend / keep / delete (existing guarded path); others only organise @laptop', async ({ page }) => {
		resetOrganiser();
		const f = await mock.fixture();
		await openLibrary(page);
		await page.getByTestId('lib-manage').click();
		await select(page, [key(f.custom), key(f.road)]);
		await expect(page.getByTestId('m-move')).toBeEnabled();
		await expect(page.getByTestId('m-pin')).toBeEnabled();
		for (const t of ['m-extend', 'm-keep', 'm-delete']) await expect(page.getByTestId(t)).toHaveCount(0);
		await entry(page, key(f.road)).getByRole('checkbox').click(); // deselect: only the Custom one
		for (const t of ['m-extend', 'm-keep', 'm-delete']) await expect(page.getByTestId(t)).toBeVisible();
		const before = sql(`SELECT coalesce(expires_at::text, 'none') FROM custom_playlists WHERE playlist_id = '${f.custom}'`);
		await mock.resetCalls();
		await page.getByTestId('m-extend').click();
		await expect.poll(() => sql(`SELECT coalesce(expires_at::text, 'none') FROM custom_playlists WHERE playlist_id = '${f.custom}'`)).not.toBe(before);
		expect(await mock.writes()).toEqual([]); // extend is a database change
		// Followed / own unmanaged / spoofed: organise only.
		for (const pid of [f.followed, f.spoof, f.stolen]) {
			await page.getByTestId('lib-manage').click();
			await page.getByTestId('lib-manage').click();
			const k = key(pid);
			if ((await entry(page, k).count()) === 0) continue;
			await select(page, [k]);
			for (const t of ['m-extend', 'm-keep', 'm-delete']) await expect(page.getByTestId(t)).toHaveCount(0);
			await entry(page, k).getByRole('checkbox').click();
		}
	});

	test('V091-10 zero Spotify writes from pins, folders, moves and reorders (UI + API) @laptop', async ({ page, request, baseURL }) => {
		resetOrganiser();
		const f = await mock.fixture();
		await mock.resetCalls();
		const h = origin(baseURL);
		const fid = (await (await request.post('/api/library/folders', { headers: h, data: { name: 'No writes' } })).json()).folder.id;
		const sub = (await (await request.post('/api/library/folders', { headers: h, data: { name: 'No writes sub', parentId: fid } })).json()).folder.id;
		for (const r of [
			await request.post('/api/library/move', { headers: h, data: { keys: [key(f.top30), key(f.snapshot), 'rotor:liked'], folderId: fid } }),
			await request.post('/api/library/pin', { headers: h, data: { targets: [key(f.road), `folder:${sub}`, key(f.followed)], pinned: true } }),
			await request.put('/api/library/pins', { headers: h, data: { targets: [key(f.followed), key(f.road)] } }),
			await request.put('/api/library/order', { headers: h, data: { folderId: null, targets: [key(f.custom), key(f.spoof)] } }),
			await request.patch(`/api/library/folders/${fid}`, { headers: h, data: { name: 'Renamed' } }),
			await request.post('/api/library/pin', { headers: h, data: { targets: [key(f.road)], pinned: false } }),
			await request.post('/api/library/move', { headers: h, data: { keys: [key(f.top30)], folderId: null } }),
			await request.delete(`/api/library/folders/${fid}`, { headers: h })
		])
			expect(r.status(), await r.text()).toBeLessThan(300);
		await openLibrary(page);
		await page.getByTestId('lib-manage').click();
		await select(page, [key(f.custom)]);
		await page.getByTestId('m-pin').click();
		await expect(page.getByTestId('pinned').locator(`[data-key="${key(f.custom)}"]`)).toBeVisible();
		const calls = await mock.calls();
		expect(calls.filter((c) => c.host === 'api.spotify.com' && c.method !== 'GET')).toEqual([]);
		// A YouTube collection may be pinned but never put in a folder.
		const bad = await request.post('/api/library/move', { headers: h, data: { keys: ['rotor:collection:0f3a9b2c-1d2e-4f5a-8b6c-7d8e9f0a1b2c'], folderId: sub } });
		expect(bad.status()).toBe(400);
	});

	test('V091-11 YouTube collections can be pinned; they stay on top of their own space, never next to Spotify @laptop', async ({ page }) => {
		resetOrganiser();
		const n = sqlNum(`SELECT count(*) FROM collections WHERE source = 'youtube'`);
		test.skip(n === 0, 'no YouTube collection imported in this run');
		await page.goto('/library?source=youtube');
		const first = page.getByTestId('collection').first();
		await expect(first).toBeVisible();
		const cid = (await first.getAttribute('data-id'))!;
		await first.getByRole('button', { name: /^Pin / }).click();
		await expect(page.getByTestId('pinned-collections').locator(`[data-id="${cid}"]`)).toBeVisible();
		expect(sqlNum(`SELECT count(*) FROM library_items WHERE item_key = 'rotor:collection:${cid}' AND pin_pos IS NOT NULL`)).toBe(1);
		await page.goto('/library?source=spotify');
		await expect(page.locator('[data-testid=entries] [data-testid=entry]').first()).toBeVisible();
		await expect(page.locator(`[data-key="rotor:collection:${cid}"]`)).toHaveCount(0);
	});

	test('V091-12 the organiser tables stay at KBs (measured with a busy library: 40 folders, 300 playlists, 60 pins) @laptop', async () => {
		resetOrganiser();
		sql(`INSERT INTO library_folders (name, parent_id, position, pin_pos) SELECT 'Folder ' || g, NULL, g, CASE WHEN g <= 10 THEN g END FROM generate_series(1, 20) g`);
		sql(`INSERT INTO library_folders (name, parent_id, position) SELECT 'Sub ' || g, (SELECT min(id) FROM library_folders) + (g % 20), g FROM generate_series(1, 20) g`);
		sql(`INSERT INTO library_items (item_key, folder_id, position, pin_pos)
		     SELECT 'spotify:playlist:' || lpad(g::text, 22, 'x'), CASE WHEN g % 3 = 0 THEN NULL ELSE (SELECT min(id) FROM library_folders) + (g % 40) END, g, CASE WHEN g <= 50 THEN 100 + g END
		     FROM generate_series(1, 300) g`);
		const r = sql(`SELECT pg_total_relation_size('library_folders'), pg_total_relation_size('library_items'),
		                      (SELECT coalesce(sum(pg_column_size(f.*)), 0) FROM library_folders f), (SELECT coalesce(sum(pg_column_size(i.*)), 0) FROM library_items i)`).split('|').map(Number);
		const result = { folders: 40, items: 300, pins: 60, foldersTableBytes: r[0], itemsTableBytes: r[1], foldersRowBytes: r[2], itemsRowBytes: r[3], totalOnDisk: r[0]! + r[1]! };
		writeFileSync(join(OUT, 'organiser-sizes.json'), JSON.stringify(result, null, 2));
		console.log(`[organiser-sizes] ${JSON.stringify(result)}`);
		expect(result.totalOnDisk).toBeLessThan(256 * 1024);
		resetOrganiser();
	});
});
