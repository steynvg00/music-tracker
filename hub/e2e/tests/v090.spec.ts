/**
 * v0.90: Artist pages (beta) + Spotify catalog search + storage-light cache + database diet.
 * Every Spotify call is answered by the mock (e2e/mock/spotify-mock.mjs, `catalog` section).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, mock, sql, sqlNum, type MockCall } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const OUT = process.env.E2E_OUT ?? 'e2e/.out';
const DB = process.env.E2E_DB ?? '';
const PSQL = join(process.env.PG_BIN ?? '/usr/local/opt/postgresql@16/bin', 'psql');
const SMALL = 'SynthSmall000000000020';
const MEDIUM = 'SynthMedium00000000150';
const LARGE = 'SynthLarge000000000600';
const FRESH = 'SynthFresh000000000003';
const GROUPS = ['album', 'single', 'compilation', 'appears_on'] as const;

async function flagOn(page: Page) {
	await page.addInitScript(() => localStorage.setItem('rotor.flag.artistPages', '1'));
}
const catalogCalls = (calls: MockCall[]) => calls.filter((c) => c.who === 'hub' && c.host === 'api.spotify.com' && /^\/v1\/(artists|albums|search)/.test(c.path));
const dateKey = (d: string) => {
	if (!d) return '';
	const [y = '0000', m = '00', dd = '00'] = d.split('-');
	return `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`;
};
function forgetArtist(id: string) {
	sql(`DELETE FROM catalog_artist_cache WHERE artist_id = '${id}'`);
}
async function openArtist(page: Page, id: string) {
	await page.goto(`/catalog/artist/${id}`);
	await expect(page.getByTestId('artist-name')).toBeVisible({ timeout: 30_000 });
}
/** Load every appears-on album's own tracks through the real API, in the page's batch size. */
async function loadAllAppears(page: Page, id: string) {
	const r = await page.request.get(`/api/catalog/artist/${id}`);
	const body = (await r.json()) as { releases: { id: string; group: string }[] };
	const ids = body.releases.filter((x) => x.group === 'appears_on').map((x) => x.id);
	for (let i = 0; i < ids.length; i += 12) {
		const res = await page.request.post(`/api/catalog/artist/${id}/appears`, { data: { albums: ids.slice(i, i + 12) }, headers: { Origin: new URL(page.url()).origin } });
		expect(res.status()).toBe(200);
	}
	return ids.length;
}

test.describe('v0.90 Artist pages (beta)', () => {
	test('V090-1 flag OFF (default): artist links, Search and Settings are unchanged, no catalog call @laptop', async ({ page }) => {
		const f = (await mock.fixture()).catalog;
		await mock.resetCalls();
		await page.goto('/settings');
		await expect(page.getByTestId('flag-artist-pages')).not.toBeChecked();
		await page.goto(`/artist/${f.artist0}`);
		await page.waitForLoadState('networkidle');
		await expect(page).toHaveURL(new RegExp(`/artist/${f.artist0}$`));
		await expect(page.getByTestId('to-beta')).toHaveCount(0);
		await page.goto('/search?q=da');
		await expect(page.getByTestId('tab-spotify')).toHaveCount(0);
		await page.goto(`/catalog/artist/${f.artist0}`);
		await expect(page.getByTestId('beta-off')).toBeVisible();
		await page.goto(`/search?q=synth&src=spotify`);
		await expect(page.getByTestId('catalog-search')).toHaveCount(0);
		expect(catalogCalls(await mock.calls())).toEqual([]);
	});

	test('V090-2 the Settings toggle turns it on for this device; artist links open the beta page, "Full stats & badges" the R3 page @laptop', async ({ page }) => {
		const f = (await mock.fixture()).catalog;
		await page.goto('/settings');
		await page.getByTestId('flag-artist-pages').check();
		expect(await page.evaluate(() => localStorage.getItem('rotor.flag.artistPages'))).toBe('1');
		// A link to /artist/{id} (here: from a track page) now lands on the beta page.
		const track = sql(`SELECT track_uri FROM track_metadata WHERE artist_ids[1] = '${f.artist0}' AND canonical_track_uri = track_uri LIMIT 1`);
		await page.goto(`/track/${encodeURIComponent(track)}`);
		await page.locator(`a[href="/artist/${f.artist0}"]`).first().click();
		await expect(page).toHaveURL(new RegExp(`/catalog/artist/${f.artist0}$`));
		await expect(page.getByTestId('artist-name')).toBeVisible({ timeout: 20_000 });
		// Header = MY numbers (rollups), not Spotify's.
		const plays = sqlNum(`SELECT plays FROM hub.mv_artist_stats WHERE artist_id = '${f.artist0}'`);
		const tracks = sqlNum(`SELECT tracks FROM hub.mv_artist_stats WHERE artist_id = '${f.artist0}'`);
		const mine = page.getByTestId('mine');
		await expect(mine).toContainText(plays.toLocaleString('en-GB'));
		await expect(mine).toContainText(String(tracks));
		await expect(page.getByTestId('badges')).toBeVisible(); // artist0 has a seeded badge
		await expect(page.getByTestId('artist-beta').getByText(/popular/i)).toHaveCount(0); // no "popular tracks" section
		await page.getByTestId('full-stats').click();
		await expect(page).toHaveURL(new RegExp(`/artist/${f.artist0}\\?stats=1$`));
		await page.waitForLoadState('networkidle');
		await expect(page).toHaveURL(new RegExp(`/artist/${f.artist0}\\?stats=1$`)); // no bounce back
		// A server-rendered first load of /artist/{id} redirects after hydration.
		await flagOn(page);
		await page.goto(`/artist/${f.artist0}`);
		await expect(page).toHaveURL(new RegExp(`/catalog/artist/${f.artist0}$`));
	});

	test('V090-3 nothing hidden: every release of every group on the page, newest first with year headers, toggle oldest first @laptop', async ({ page }) => {
		await flagOn(page);
		forgetArtist(MEDIUM);
		await openArtist(page, MEDIUM);
		const want = { album: 10, single: 60, compilation: 5, appears_on: 75 };
		for (const g of GROUPS) {
			await expect(page.getByTestId(`group-${g}`).getByTestId('release')).toHaveCount(want[g]);
			await expect(page.getByTestId(`jump-${g}`)).toContainText(String(want[g]));
		}
		await expect(page.getByTestId('release')).toHaveCount(150);
		const check = async (order: 'newest' | 'oldest') => {
			for (const g of GROUPS) {
				const dates = await page.getByTestId(`group-${g}`).getByTestId('release').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.date ?? ''));
				const keys = dates.map(dateKey);
				const sorted = [...keys].sort();
				expect(keys).toEqual(order === 'newest' ? sorted.reverse() : sorted);
				const years = await page.getByTestId(`group-${g}`).getByTestId('year').allTextContents();
				const expectedYears = [...new Set(dates.map((d) => d.slice(0, 4)))];
				expect(years).toEqual(expectedYears);
			}
		};
		await check('newest');
		await page.getByTestId('sort-oldest').click();
		await check('oldest');
		// Each release shows cover, title, date, type, track count and my state.
		const first = page.getByTestId('group-single').getByTestId('release').first();
		await expect(first.locator('.art')).toHaveCount(1); // the cover (the E2E browser can't load i.scdn.co: placeholder)
		const api = (await (await page.request.get(`/api/catalog/artist/${MEDIUM}`)).json()) as { releases: { cover: string | null }[] };
		expect(api.releases.every((r) => r.cover?.startsWith('https://i.scdn.co/image/ab67616d00001e02'))).toBe(true); // one size: 300 px
		await expect(first).toContainText(/tracks?/);
		await expect(first.getByTestId('release-state')).toHaveText(/Not heard|Played|Liked/);
	});

	test('V090-4 appears on: ONLY the artist\'s own tracks under each release; "Show full album" expands the whole tracklist (live, not stored) @laptop', async ({ page }) => {
		const f = (await mock.fixture()).catalog;
		await flagOn(page);
		forgetArtist(f.artist0);
		await openArtist(page, f.artist0);
		const comp = page.locator(`[data-testid="release"][data-id="${f.comp}"]`);
		await comp.scrollIntoViewIfNeeded();
		const own = comp.getByTestId('own-rows').getByTestId('track-row');
		await expect(own).toHaveCount(1);
		await expect(own).toHaveAttribute('data-uri', f.compOwnTrack);
		const expectedPlays = sqlNum(`SELECT coalesce(sum(plays), 0) FROM hub.mv_track_stats WHERE track_uri IN (SELECT track_uri FROM track_metadata WHERE coalesce(canonical_track_uri, track_uri) = (SELECT coalesce(canonical_track_uri, track_uri) FROM track_metadata WHERE track_uri = '${f.compOwnTrack}'))`);
		expect(expectedPlays).toBeGreaterThan(0);
		await expect(own).toHaveAttribute('data-plays', String(expectedPlays));
		await expect(comp).toHaveAttribute('data-state', /played|liked/);
		await mock.resetCalls();
		await comp.getByTestId('show-full').click();
		await expect(comp.getByTestId('full-rows').getByTestId('track-row')).toHaveCount(9);
		const calls = catalogCalls(await mock.calls()).map((c) => c.path);
		expect(calls).toContain(`/v1/albums/${f.comp}`);
		// Stored: only the artist's own track for that album; the full tracklist never.
		const stored = sql(`SELECT tracks::text FROM catalog_appears_cache WHERE artist_id = '${f.artist0}'`);
		expect(stored).toContain(f.compOwnTrack.split(':')[2]);
		expect(stored).not.toContain('CompE2ETrack01');
		// A synthetic compilation with two credited tracks shows exactly those two.
		forgetArtist(SMALL);
		await openArtist(page, SMALL);
		const p0 = page.locator(`[data-testid="release"][data-id="${SMALL.slice(0, 13)}P0000aaaa"]`);
		await p0.scrollIntoViewIfNeeded();
		await expect(p0.getByTestId('own-rows').getByTestId('track-row')).toHaveCount(2);
		await expect(p0.getByTestId('own-rows')).not.toContainText('Guest track');
	});

	test('V090-5 own releases expand to the full tracklist; ▶ plays the track, "From here" plays the release from it (Spotify Connect) @laptop', async ({ page }) => {
		const f = (await mock.fixture()).catalog;
		await flagOn(page);
		await openArtist(page, f.artist0);
		const rel = page.getByTestId('group-album').getByTestId('release').first();
		const albumId = (await rel.getAttribute('data-id'))!;
		await rel.getByTestId('expand').click();
		const rows = rel.getByTestId('full-rows').getByTestId('track-row');
		await expect(rows).toHaveCount(4);
		const second = rows.nth(1);
		const uri = (await second.getAttribute('data-uri'))!;
		await mock.resetCalls();
		await second.getByRole('button', { name: /^Play / }).click();
		await expect.poll(async () => (await mock.writes()).find((c) => c.path === '/v1/me/player/play')).toBeTruthy();
		expect((await mock.writes()).find((c) => c.path === '/v1/me/player/play')!.body).toMatchObject({ uris: [uri] });
		await mock.resetCalls();
		await second.getByRole('button', { name: /^From here/ }).click();
		await expect.poll(async () => (await mock.writes()).find((c) => c.path === '/v1/me/player/play')).toBeTruthy();
		expect((await mock.writes()).find((c) => c.path === '/v1/me/player/play')!.body).toMatchObject({ context_uri: `spotify:album:${albumId}`, offset: { uri } });
		// A release with a played track says so; the brand-new single is "Not heard".
		await expect(page.locator(`[data-testid="release"][data-id="${f.newSingle}"]`)).toHaveAttribute('data-state', 'not_heard');
		await expect(rel).toHaveAttribute('data-state', /played|liked/);
	});

	test('V090-6 cache: a second open makes no Spotify call; 7-day TTL refetches; Data health shows size and hit rate @laptop', async ({ page }) => {
		await flagOn(page);
		forgetArtist(MEDIUM);
		const before = sql(`SELECT hits || ':' || misses FROM catalog_cache_stats`).split(':').map(Number);
		await mock.resetCalls();
		await openArtist(page, MEDIUM);
		const first = catalogCalls(await mock.calls());
		expect(first.length).toBeGreaterThanOrEqual(5); // artist + 4 groups (+ pages)
		expect(first.filter((c) => /\/albums$/.test(c.path)).every((c) => !new URLSearchParams(c.query).get('include_groups')!.includes(','))).toBe(true);
		await mock.resetCalls();
		await page.reload();
		await expect(page.getByTestId('artist-name')).toBeVisible();
		expect(catalogCalls(await mock.calls()).filter((c) => c.path.startsWith('/v1/artists/'))).toEqual([]);
		const after = sql(`SELECT hits || ':' || misses FROM catalog_cache_stats`).split(':').map(Number);
		expect(after[0]!).toBeGreaterThan(before[0]!);
		expect(after[1]!).toBeGreaterThan(before[1]!);
		// TTL: 8 days old → refetched on the next open.
		sql(`UPDATE catalog_artist_cache SET fetched_at = now() - interval '8 days' WHERE artist_id = '${MEDIUM}'`);
		await mock.resetCalls();
		await page.reload();
		await expect(page.getByTestId('artist-name')).toBeVisible();
		expect(catalogCalls(await mock.calls()).some((c) => c.path === `/v1/artists/${MEDIUM}`)).toBe(true);
		expect(sqlNum(`SELECT extract(epoch FROM now() - fetched_at)::int FROM catalog_artist_cache WHERE artist_id = '${MEDIUM}'`)).toBeLessThan(120);
		await page.goto('/settings/health');
		await expect(page.getByTestId('health-catalog')).toBeVisible();
		await expect(page.getByTestId('catalog-hitrate')).toContainText('%');
		const logical = sqlNum(`SELECT sum(bytes) FROM catalog_artist_cache`);
		expect(logical).toBeGreaterThan(0);
		await expect(page.getByTestId('health-db-warn')).toHaveCount(0); // the throwaway DB is far below 450 MB
	});

	test('V090-7 hard cap: least recently opened artists are evicted to stay under 20 MB; the open artist never is @laptop', async ({ page }) => {
		await flagOn(page);
		// 30 cached artists of 1 MB each (logical size), opened 1…30 hours ago.
		sql(`INSERT INTO catalog_artist_cache (artist_id, name, image, releases, fetched_at, accessed_at, bytes)
		     SELECT 'CapFill' || lpad(g::text, 15, '0'), 'Filler ' || g, NULL, '[]'::jsonb, now(), now() - g * interval '1 hour', 1048576
		     FROM generate_series(1, 30) g`);
		const ev0 = sqlNum(`SELECT evictions FROM catalog_cache_stats`);
		forgetArtist(FRESH);
		await openArtist(page, FRESH);
		const total = sqlNum(`SELECT sum(bytes) FROM catalog_artist_cache`);
		expect(total).toBeLessThanOrEqual(20 * 1024 * 1024);
		expect(sqlNum(`SELECT count(*) FROM catalog_artist_cache WHERE artist_id = '${FRESH}'`)).toBe(1);
		const left = sql(`SELECT string_agg(artist_id, ',' ORDER BY artist_id) FROM catalog_artist_cache WHERE artist_id LIKE 'CapFill%'`).split(',');
		// The newest fillers survive, the oldest go.
		expect(left).toContain('CapFill000000000000001');
		expect(left).not.toContain('CapFill000000000000030');
		expect(sqlNum(`SELECT evictions FROM catalog_cache_stats`)).toBeGreaterThan(ev0);
		await page.goto('/settings/health');
		await expect(page.getByTestId('catalog-evictions')).not.toHaveText('0');
		sql(`DELETE FROM catalog_artist_cache WHERE artist_id LIKE 'CapFill%'`);
	});

	test('V090-8 Spotify 429: short Retry-After is waited out server-side; a long one reaches the page, which says so @laptop', async ({ page }) => {
		await flagOn(page);
		const rl0 = sqlNum(`SELECT rate_limited FROM catalog_cache_stats`);
		forgetArtist(FRESH);
		const st = await mock.state();
		await mock.set({ catalog: { ...st.catalog, fail429: 2, retryAfter: 1 } });
		await mock.resetCalls();
		await openArtist(page, FRESH);
		const calls = catalogCalls(await mock.calls());
		expect(calls.filter((c) => c.status === 429)).toHaveLength(2);
		expect(sqlNum(`SELECT rate_limited FROM catalog_cache_stats`)).toBe(rl0 + 2);
		// Retry-After 8 s: more than the server waits (3 s) → the page shows it and retries later.
		forgetArtist(SMALL);
		await mock.set({ catalog: { ...(await mock.state()).catalog, fail429: 100, retryAfter: 8 } });
		await page.goto(`/catalog/artist/${SMALL}`);
		await expect(page.getByTestId('rate-limited')).toContainText('8 s');
		await mock.set({ catalog: { ...(await mock.state()).catalog, fail429: 0, retryAfter: 1 } });
	});

	test('V090-9 big artists load progressively: skeletons first, appears-on tracks in batches of ≤ 12 as you scroll @laptop', async ({ page }) => {
		await flagOn(page);
		forgetArtist(LARGE);
		const posts: number[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().includes(`/api/catalog/artist/${LARGE}/appears`)) posts.push((JSON.parse(r.postData() ?? '{}').albums ?? []).length);
		});
		await page.goto(`/catalog/artist/${LARGE}`);
		await expect(page.getByTestId('artist-skeleton').or(page.getByTestId('artist-name'))).toBeVisible();
		await expect(page.getByTestId('artist-name')).toBeVisible({ timeout: 45_000 });
		await expect(page.getByTestId('release')).toHaveCount(600);
		const appears = page.getByTestId('group-appears_on').getByTestId('release');
		await expect(appears).toHaveCount(420);
		// Far-down cards still show skeleton rows (not loaded yet) …
		await expect(appears.last().locator('[aria-busy="true"]')).toHaveCount(1);
		// … and load once scrolled to.
		await appears.last().scrollIntoViewIfNeeded();
		await expect(appears.last().getByTestId('own-rows')).toBeVisible({ timeout: 20_000 });
		expect(posts.length).toBeGreaterThan(0);
		expect(Math.max(...posts)).toBeLessThanOrEqual(12);
		expect(posts.reduce((a, b) => a + b, 0)).toBeLessThan(420); // only what was on screen
	});

	test('V090-10 measured: bytes stored per artist (20 / 150 / 600 releases, appears-on fully loaded) @laptop', async ({ page }) => {
		await flagOn(page);
		await page.goto('/home');
		const rows: Record<string, unknown>[] = [];
		for (const [id, n] of [[SMALL, 20], [MEDIUM, 150], [LARGE, 600]] as const) {
			forgetArtist(id);
			await openArtist(page, id);
			await page.goto('/settings'); // leave the page: only this test loads appears-on tracks now
			const appears = await loadAllAppears(page, id);
			const r = sql(`SELECT a.bytes, pg_column_size(a.*), (SELECT count(*) FROM catalog_appears_cache p WHERE p.artist_id = a.artist_id),
			                      (SELECT coalesce(sum(pg_column_size(p.*)), 0) FROM catalog_appears_cache p WHERE p.artist_id = a.artist_id),
			                      jsonb_array_length(a.releases), octet_length(a.releases::text)
			               FROM catalog_artist_cache a WHERE a.artist_id = '${id}'`).split('|').map(Number);
			const ownTracks = sqlNum(`SELECT coalesce(sum(jsonb_array_length(v)), 0) FROM catalog_appears_cache p, jsonb_each(p.tracks) e(k, v) WHERE p.artist_id = '${id}'`);
			const appearsText = sqlNum(`SELECT coalesce(sum(octet_length(tracks::text)), 0) FROM catalog_appears_cache WHERE artist_id = '${id}'`);
			expect(r[4]).toBe(n);
			rows.push({ artist: id, releases: n, appearsOn: appears, ownTracksStored: ownTracks, bytes: r[0], artistRowBytes: r[1], appearsRows: r[2], appearsBytes: r[3], releasesJsonText: r[5], appearsJsonText: appearsText, uncompressedUpperBound: r[5]! + appearsText, bytesPerRelease: Math.round((r[0]! / n) * 10) / 10 });
		}
		const physical = sqlNum(`SELECT pg_total_relation_size('catalog_artist_cache') + pg_total_relation_size('catalog_appears_cache')`);
		const result = { measuredAt: new Date().toISOString(), perArtist: rows, physicalBytesBothTables: physical, logicalBytesAll: sqlNum(`SELECT sum(bytes) FROM catalog_artist_cache`) };
		writeFileSync(join(OUT, 'catalog-sizes.json'), JSON.stringify(result, null, 2));
		console.log(`[catalog-sizes] ${JSON.stringify(result)}`);
		expect((rows[2]!.bytes as number) < 1024 * 1024).toBe(true); // a 600-release artist stays far below 1 MB
	});
});

test.describe('v0.90 Spotify catalog search', () => {
	test('V090-11 Search › Spotify: 10 per request, "Load more" pages by 10, results link to the beta artist and album pages @laptop', async ({ page }) => {
		await flagOn(page);
		await mock.resetCalls();
		await page.goto('/search?q=synth');
		await page.getByTestId('tab-spotify').click();
		await expect(page).toHaveURL(/src=spotify/);
		const artists = page.getByTestId('cs-artists').getByTestId('cs-artist');
		await expect(artists).toHaveCount(10);
		await page.getByTestId('more-artist').click();
		await expect(artists).toHaveCount(20);
		await page.getByTestId('more-artist').click();
		await expect(artists).toHaveCount(25);
		await expect(page.getByTestId('more-artist')).toHaveCount(0);
		const searches = catalogCalls(await mock.calls()).filter((c) => c.path === '/v1/search');
		expect(searches.length).toBeGreaterThanOrEqual(3);
		for (const s of searches) expect(Number(new URLSearchParams(s.query).get('limit'))).toBeLessThanOrEqual(10);
		expect(searches.map((s) => new URLSearchParams(s.query).get('offset'))).toEqual(expect.arrayContaining(['0', '10', '20']));
		await expect(page.getByTestId('cs-albums').getByTestId('cs-album')).toHaveCount(10);
		await page.getByTestId('more-album').click();
		await expect(page.getByTestId('cs-albums').getByTestId('cs-album')).toHaveCount(20);
		// Track result: ▶ plays it.
		await mock.resetCalls();
		await page.getByTestId('cs-track').first().getByRole('button', { name: /^Play / }).click();
		await expect.poll(async () => (await mock.writes()).find((c) => c.path === '/v1/me/player/play')).toBeTruthy();
		// Album result → album page with tracklist + my state per track.
		await page.getByTestId('cs-album').first().click();
		await expect(page).toHaveURL(/\/catalog\/album\//);
		await expect(page.getByTestId('album-name')).toBeVisible();
		await expect(page.getByTestId('album-rows').getByTestId('track-row').first()).toBeVisible();
		await expect(page.getByTestId('album-state')).toHaveText(/Not heard|Played|Liked/);
		// Artist result → beta artist page.
		await page.goto('/search?q=synth&src=spotify');
		await page.getByTestId('cs-artist').filter({ hasText: 'Synth Medium' }).click();
		await expect(page).toHaveURL(new RegExp(`/catalog/artist/${MEDIUM}$`));
		await expect(page.getByTestId('artist-name')).toHaveText('Synth Medium');
	});

	test('V090-12 Search › Spotify on the phone @mobile', async ({ page }) => {
		await flagOn(page);
		await page.goto('/search?q=synth&src=spotify');
		await expect(page.getByTestId('cs-artists').getByTestId('cs-artist')).toHaveCount(10);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});
});

test.describe('v0.90 database diet', () => {
	test('V090-13 archive_scrobbles.py exports + verifies on a real Postgres and never drops; 0033 refuses a wrong count, drops on the right one @laptop', async () => {
		const existed = sql(`SELECT to_regclass('public.scrobbles') IS NOT NULL`) === 't';
		if (!existed) {
			sql(`CREATE TABLE scrobbles (
				id BIGSERIAL PRIMARY KEY, track_id BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, played_at TIMESTAMPTZ NOT NULL,
				source TEXT NOT NULL CHECK (source IN ('lastfm', 'spotify_extended')), ms_played INTEGER, reason_start TEXT, reason_end TEXT,
				shuffle BOOLEAN, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (source, played_at, track_id))`);
		}
		sql(`INSERT INTO artists (name) VALUES ('Archive Test Artist') ON CONFLICT DO NOTHING`);
		sql(`INSERT INTO tracks (artist_id, title) SELECT id, 'Archive Test Track ' || g FROM artists, generate_series(1, 5) g WHERE name = 'Archive Test Artist'`);
		sql(`INSERT INTO scrobbles (track_id, played_at, source, ms_played, reason_start, reason_end, shuffle)
		     SELECT t.id, timestamptz '2016-01-01 00:00:00.123456+00' + g * interval '17 minutes 3.5 seconds', CASE WHEN g % 3 = 0 THEN 'spotify_extended' ELSE 'lastfm' END,
		            CASE WHEN g % 4 = 0 THEN NULL ELSE g * 1000 END, CASE WHEN g % 5 = 0 THEN 'clickrow' END, CASE WHEN g % 2 = 0 THEN 'trackdone, "quoted"' END,
		            CASE g % 3 WHEN 0 THEN true WHEN 1 THEN false END
		     FROM generate_series(1, 1500) g JOIN tracks t ON t.title = 'Archive Test Track ' || (1 + g % 5)`);
		const n = sqlNum(`SELECT count(*) FROM scrobbles`);
		expect(n).toBeGreaterThanOrEqual(1500);
		const dir = mkdtempSync(join(tmpdir(), 'rotor-archive-'));
		const run = spawnSync('uv', ['run', '--no-sync', 'python', 'scripts/archive_scrobbles.py', '--out-dir', dir, '--db', DB], { cwd: REPO, encoding: 'utf8' });
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toContain('VERIFIED');
		expect(run.stdout).toContain(`SET rotor.scrobbles_archived_rows = '${n}';`);
		expect(readdirSync(dir).sort().map((f) => f.replace(/\d{8}T\d{6}Z/, 'TS'))).toEqual(['scrobbles_TS.csv.gz', 'scrobbles_TS.manifest.json']);
		expect(sqlNum(`SELECT count(*) FROM scrobbles`)).toBe(n); // never drops or deletes
		const gz = readdirSync(dir).find((f) => f.endsWith('.csv.gz'))!;
		const again = spawnSync('uv', ['run', '--no-sync', 'python', 'scripts/archive_scrobbles.py', '--verify', join(dir, gz), '--db', DB], { cwd: REPO, encoding: 'utf8' });
		expect(again.status, again.stderr).toBe(0);
		// 0033: a wrong count → refused, the table stays.
		const apply = (rows: number) =>
			spawnSync(PSQL, ['-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', join(REPO, 'migrations', '0033_drop_scrobbles_AFTER_ARCHIVE.sql')], {
				encoding: 'utf8',
				env: { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: `-c rotor.scrobbles_archived_rows=${rows}` }
			});
		const wrong = apply(n - 1);
		expect(wrong.status).not.toBe(0);
		expect(wrong.stderr).toContain('0033 refused');
		expect(sql(`SELECT to_regclass('public.scrobbles') IS NOT NULL`)).toBe('t');
		const missing = spawnSync(PSQL, ['-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', join(REPO, 'migrations', '0033_drop_scrobbles_AFTER_ARCHIVE.sql')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '' } });
		expect(missing.status).not.toBe(0);
		const right = apply(n);
		expect(right.status, right.stderr).toBe(0);
		expect(sql(`SELECT to_regclass('public.scrobbles') IS NULL`)).toBe('t');
		expect(sql(`SELECT count(*) FROM migrations_applied WHERE number = 33`)).toBe('1');
		// unified_plays still works without scrobbles.
		expect(sqlNum(`SELECT count(*) FROM unified_plays`)).toBeGreaterThan(0);
	});

	test('V090-14 without scrobbles Data health still loads (last.fm line says archived) @laptop', async ({ page }) => {
		expect(sql(`SELECT to_regclass('public.scrobbles') IS NULL`)).toBe('t');
		await page.goto('/settings/health');
		await expect(page.getByTestId('health-db')).toBeVisible();
		await expect(page.getByText('archived (0033) or not imported')).toBeVisible();
	});

	test('V090-16 Data health warns above 450 MB (size from the API, threshold from shared/health) @laptop', async ({ page }) => {
		// The throwaway DB is a few MB: rewrite the API's size on the way to the page (client navigation).
		await page.route('**/api/health**', async (route) => {
			const res = await route.fetch();
			const body = await res.json();
			body.database.bytes = 460 * 1024 * 1024;
			body.database.pct = 92;
			body.database.tone = 'danger';
			body.database.overWarn = body.database.bytes > body.database.warnBytes;
			await route.fulfill({ response: res, json: body });
		});
		await page.goto('/settings');
		await page.getByTestId('open-health').click();
		await expect(page.getByTestId('health-db-warn')).toBeVisible();
		await expect(page.getByTestId('health-db-warn')).toContainText('450.0 MB');
		await expect(page.getByTestId('health-db')).toContainText('460.0 MB');
	});

	test('V090-15 0032 index diet is applied and every remaining hub query plan still works @laptop', async () => {
		const max = Number(process.env.E2E_MAX_MIGRATION ?? 99);
		test.skip(max < 32, 'index audit run (0032 not applied on purpose)');
		for (const ix of ['day_track_artist', 'idx_badge_events_entity', 'idx_track_metadata_artist_names']) {
			expect(sql(`SELECT count(*) FROM pg_indexes WHERE indexname = '${ix}'`), ix).toBe('0');
		}
		for (const ix of ['day_track_artist_d', 'day_track_artist_track_d', 'badge_events_unique_awarded', 'idx_track_metadata_artist_ids', 'spotify_plays_artist_name_idx']) {
			expect(sql(`SELECT count(*) FROM pg_indexes WHERE indexname = '${ix}'`), ix).toBe('1');
		}
		expect(sql(`SELECT count(*) FROM migrations_applied WHERE number = 32`)).toBe('1');
		// The queries that used the dropped day_track_artist (artist battle, rank race, Wrapped comebacks) still use an index.
		const plan = execFileSync(PSQL, ['-At', '-d', DB, '-c', `SET enable_seqscan = off; EXPLAIN SELECT d, plays FROM hub.day_track WHERE artist = 'Da Tweekaz' AND d < '2025-01-01'`], { encoding: 'utf8' });
		expect(plan).toMatch(/day_track_artist_(d|track_d)/);
	});
});
