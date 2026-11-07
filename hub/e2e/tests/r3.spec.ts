/** R3: stats parity with Streamlit (its SQL, verbatim), Stats screens, detail pages, Search, Home. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, mock, sql, sqlNum } from './fixtures';

const REPO = process.env.E2E_REPO_ROOT ?? '../..';
const origin = (b: string | undefined) => ({ Origin: b ?? 'http://localhost:47173', 'Content-Type': 'application/json' });
const fmt = (n: number) => new Intl.NumberFormat('en-GB').format(n);
const thisYear = () => Number(sql(`SELECT extract(year FROM now() AT TIME ZONE 'Europe/Amsterdam')::int`));

// ── Streamlit's queries, copied verbatim from views/stats.py and views/_stats_*_lookup.py ──
const ST_TOTAL = `SELECT COUNT(*) AS n FROM unified_plays`;
const ST_CURRENT_STREAK = `
            WITH days AS (
                SELECT DISTINCT DATE(played_at AT TIME ZONE 'Europe/Amsterdam') AS d
                FROM unified_plays
            ),
            groups AS (
                SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS grp FROM days
            ),
            streaks AS (
                SELECT grp, MIN(d) AS start_d, MAX(d) AS end_d, COUNT(*) AS len FROM groups GROUP BY grp
            )
            SELECT len FROM streaks
            WHERE end_d >= (CURRENT_DATE AT TIME ZONE 'Europe/Amsterdam')::date - INTERVAL '1 day'
            ORDER BY end_d DESC LIMIT 1`;
const ST_YIR_TOP10 = (y: number) => `
            SELECT artist, track, COUNT(*) AS plays
            FROM unified_plays
            WHERE EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam') = ${y}
            GROUP BY artist, track
            ORDER BY plays DESC
            LIMIT 10`;
const ST_TRACK_PLAYS = (canonical: string) => `
        SELECT
            COUNT(*) AS total_plays
        FROM spotify_plays sp
        JOIN track_metadata tm ON tm.track_uri = sp.track_uri
        WHERE tm.canonical_track_uri = '${canonical}'
          AND tm.canonical_track_uri IS NOT NULL`;
const ST_ARTIST_PLAYS = (id: string) => `
            SELECT COUNT(*) AS plays
            FROM spotify_plays sp
            JOIN track_metadata tm ON tm.track_uri = sp.track_uri
            WHERE '${id}' = ANY(tm.artist_ids) AND sp.track_uri IS NOT NULL`;
const ST_ON_THIS_DAY = `
            SELECT EXTRACT(YEAR FROM played_at AT TIME ZONE 'Europe/Amsterdam')::int AS year,
                   artist, track, COUNT(*) AS plays
            FROM unified_plays
            WHERE EXTRACT(MONTH FROM played_at AT TIME ZONE 'Europe/Amsterdam') = EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'Europe/Amsterdam'))
              AND EXTRACT(DAY FROM played_at AT TIME ZONE 'Europe/Amsterdam') = EXTRACT(DAY FROM (NOW() AT TIME ZONE 'Europe/Amsterdam'))
            GROUP BY year, artist, track
            ORDER BY year DESC, plays DESC`;
const ST_SKIP_RATE = `
            SELECT
                ROUND(100.0 * COUNT(*) FILTER (WHERE reason_end = 'fwdbtn') / COUNT(*), 1) AS skip_rate_pct
            FROM spotify_plays
            WHERE track_uri IS NOT NULL`;

test.describe('R3 parity', () => {
	test('R3-1 five numbers match Streamlit: total plays, current streak, top-10 this year, one track, one artist @laptop', async ({ page, request }) => {
		const f = await mock.fixture();
		const ov = await (await request.get('/api/stats/overview')).json();
		expect(ov.totals.plays).toBe(sqlNum(ST_TOTAL));
		expect(ov.streaks.current).toBe(sqlNum(ST_CURRENT_STREAK));

		const y = thisYear();
		const yr = await (await request.get(`/api/stats/year?year=${y}`)).json();
		const st = sql(ST_YIR_TOP10(y)).split('\n').map((l) => l.split('|'));
		expect(yr.topTracks.map((t: { plays: number }) => t.plays)).toEqual(st.map((r) => Number(r[2])));
		const unique = (p: number) => st.filter((r) => Number(r[2]) === p).length === 1;
		for (const [artist, track, plays] of st) if (unique(Number(plays))) expect(yr.topTracks.find((t: { plays: number }) => t.plays === Number(plays))).toMatchObject({ artist, track });

		const tr = await (await request.get(`/api/track/${encodeURIComponent(f.variant0)}`)).json();
		expect(tr.metrics.plays).toBe(sqlNum(ST_TRACK_PLAYS(tr.canonicalUri)));
		const ar = await (await request.get(`/api/artist/${f.artist0.id}`)).json();
		expect(ar.metrics.plays).toBe(sqlNum(ST_ARTIST_PLAYS(f.artist0.id)));

		// …and the screens show exactly those numbers.
		await page.goto('/stats');
		await expect(page.getByText(fmt(ov.totals.plays), { exact: true }).first()).toBeVisible();
		await page.goto(`/track/${encodeURIComponent(f.variant0)}`);
		await expect(page.getByText(fmt(tr.metrics.plays), { exact: true }).first()).toBeVisible();
	});

	test('R3-2 On this day matches Streamlit’s tab, year by year @laptop', async ({ request }) => {
		const st = sql(ST_ON_THIS_DAY).split('\n').filter(Boolean).map((l) => l.split('|'));
		const perYear = new Map<number, number>();
		for (const r of st) perYear.set(Number(r[0]), (perYear.get(Number(r[0])) ?? 0) + Number(r[3]));
		const rotor = await (await request.get('/api/stats/onthisday')).json();
		expect(new Map(rotor.years.map((y: { year: number; plays: number }) => [y.year, y.plays]))).toEqual(perYear);
	});

	test('R3-3 Behaviour skip rate matches Streamlit; platforms add up to all plays @laptop', async ({ request }) => {
		const b = await (await request.get('/api/stats/behaviour')).json();
		expect(b.skipRatePct).toBe(Number(sql(ST_SKIP_RATE)));
		expect(b.platforms.reduce((a: number, p: { plays: number }) => a + p.plays, 0)).toBe(sqlNum(ST_TOTAL));
	});

	test('R3-4 the 1st and 1,000th play are the same plays Streamlit numbers @laptop', async ({ request }) => {
		const r = await (await request.get('/api/stats/records')).json();
		const st = sql(`WITH numbered AS (SELECT ROW_NUMBER() OVER (ORDER BY played_at) AS n, played_at FROM unified_plays)
			SELECT n, to_char(played_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') FROM numbered WHERE n IN (1, 1000) ORDER BY n`).split('\n');
		expect(r.milestones.slice(0, 2).map((m: { at: string }) => m.at.slice(0, 19))).toEqual(st.map((l) => l.split('|')[1]));
	});
});

test.describe('R3 screens', () => {
	test('R3-5 Overview: tiles, monthly chart with hover tooltip and a table view @laptop', async ({ page }) => {
		await page.goto('/stats');
		await expect(page.getByRole('heading', { name: 'Monthly plays' })).toBeVisible();
		const chart = page.getByRole('img', { name: /Plays per month/ });
		await expect(chart).toBeVisible();
		const box = (await chart.boundingBox())!;
		await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
		await expect(page.locator('.tip').first()).toContainText('plays');
		await page.getByText('Show as table').first().click();
		await expect(page.locator('table').first()).toBeVisible();
	});

	test('R3-6 Top: this year, play the list, rank by sticky shows the all-time note @laptop', async ({ page }) => {
		await page.goto('/stats/top');
		await page.getByRole('button', { name: 'This year', exact: true }).click();
		await expect(page.getByRole('heading', { name: /Top 50 tracks · This year/ })).toBeVisible();
		await mock.resetCalls();
		await page.getByRole('button', { name: /^Play \d+$/ }).click();
		await expect.poll(async () => (await mock.writes()).find((c) => c.path === '/v1/me/player/play')).toBeTruthy();
		const play = (await mock.writes()).find((c) => c.path === '/v1/me/player/play')!;
		expect((play.body as { uris: string[] }).uris.length).toBeGreaterThan(1);
		await page.getByLabel('Rank by').selectOption('sticky');
		await expect(page.getByText(/pre-computed all-time scores/)).toBeVisible();
		await expect(page.locator('ol li .v').first()).toContainText('%');
	});

	test('R3-7 Save a Top list as a custom playlist: guarded create + add, suffix fixed @laptop', async ({ page }) => {
		await page.goto('/stats/top?range=this_year');
		await page.getByRole('button', { name: 'Save as custom playlist' }).click();
		await page.getByLabel(/^Name/).fill('Top this year');
		await mock.resetCalls();
		await page.getByRole('button', { name: /^Create · \d+ tracks$/ }).click();
		await expect(page).toHaveURL(/\/playlist\/\w{22}/, { timeout: 20_000 });
		const pid = page.url().split('/playlist/')[1]!.slice(0, 22);
		expect((await mock.state()).playlists[pid].name).toBe('Top this year · Custom 🎧');
		expect((await mock.writes()).map((w) => `${w.method} ${w.path.replace(pid, ':id')}`)).toEqual(['POST /v1/me/playlists', 'POST /v1/playlists/:id/items']);
		expect(sql(`SELECT filters_json IS NULL AND filters_summary LIKE 'from Stats%' FROM custom_playlists WHERE playlist_id = '${pid}'`)).toBe('t');
	});

	test('R3-8 Patterns heatmap (7 × 24), Year in review and Records render @both', async ({ page }) => {
		await page.goto('/stats/patterns');
		await expect(page.locator('.cell')).toHaveCount(168);
		await page.goto('/stats/year');
		await expect(page.getByRole('heading', { name: 'Top 10 tracks' })).toBeVisible();
		await page.goto('/stats/records');
		await expect(page.getByText('1st play')).toBeVisible();
		await expect(page.getByText('1,000th play')).toBeVisible();
	});

	test('R3-9 Compare by month, artist battle has a legend and both lines @laptop', async ({ page }) => {
		await page.goto('/stats/compare');
		await page.getByRole('button', { name: 'Month', exact: true }).click();
		await expect(page.locator('table.cmp tbody tr')).toHaveCount(4);
		await expect(page.locator('.lc .legend span')).toHaveCount(2);
		await expect(page.locator('.lc polyline')).toHaveCount(2);
	});

	test('R3-10 Badges page and detail-page badge grids (canonical across URI variants) @both', async ({ page }) => {
		const f = await mock.fixture();
		await page.goto('/stats/badges');
		await expect(page.getByText('#1 Month').first()).toBeVisible();
		await page.goto(`/track/${encodeURIComponent(f.track0)}`);
		await expect(page.getByRole('heading', { name: 'Versions of this recording' })).toBeVisible();
		// plays_20_in_day was earned on the single version, plays_50 on the album version: one grid.
		await expect(page.locator('li.on', { hasText: '20/day' })).toHaveCount(1);
		await expect(page.locator('li.on', { hasText: '50+' })).toHaveCount(1);
		await page.goto(`/artist/${f.artist0.id}`);
		await expect(page.locator('li.on', { hasText: '1000+ plays' })).toHaveCount(1);
	});

	test('R3-11 album page lists canonical tracks; links work from every name @laptop', async ({ page }) => {
		const f = await mock.fixture();
		await page.goto(`/track/${encodeURIComponent(f.track0)}`);
		const albumLink = page.locator('.by a[href^="/album/"]').first();
		await albumLink.click();
		await expect(page).toHaveURL(/\/album\/\w{22}/);
		await expect(page.getByRole('heading', { name: 'Tracks' })).toBeVisible();
		await page.locator('ol a[href^="/track/"]').first().click();
		await expect(page).toHaveURL(/\/track\//);
	});

	test('R3-12 Search finds your tracks, artists and playlists without calling Spotify @mobile', async ({ page }) => {
		const f = await mock.fixture();
		await mock.resetCalls();
		await page.goto('/search');
		await page.getByRole('searchbox').fill(f.artist0.name.slice(0, 7));
		await expect(page.getByRole('heading', { name: 'Artists' })).toBeVisible();
		await expect(page.getByRole('link', { name: f.artist0.name }).first()).toBeVisible();
		await page.getByRole('searchbox').fill('Late night');
		await expect(page.getByRole('link', { name: 'Late night · Custom 🎧' })).toBeVisible();
		expect((await mock.calls()).filter((c) => c.host === 'api.spotify.com' && c.path.includes('search'))).toEqual([]);
	});

	test('R3-13 Home: streak tile, On this day and Recent badges @both', async ({ page }) => {
		await page.goto('/home');
		await expect(page.getByText('Current streak')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'On this day' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Recent badges' })).toBeVisible();
		await expect(page.locator('.otd')).not.toHaveCount(0);
	});

	test('R3-14 the player’s title opens the track page @laptop', async ({ page }) => {
		await page.goto('/home');
		await page.locator('.playerbar a.tl').click();
		await expect(page).toHaveURL(/\/track\/spotify%3Atrack%3A/);
		await expect(page.getByRole('heading', { name: 'Plays per month' })).toBeVisible();
	});

	test('R3-15 stats API answers 304 for an unchanged ETag; refresh after new plays changes the totals @laptop', async ({ request }) => {
		const a = await request.get('/api/stats/overview');
		const etag = a.headers()['etag']!;
		expect((await request.get('/api/stats/overview', { headers: { 'If-None-Match': etag } })).status()).toBe(304);
		const before = (await a.json()).totals.plays;
		sql(`INSERT INTO spotify_plays (played_at, ms_played, track_uri, track_name, artist_name, album_name, reason_end)
			SELECT now() - (g || ' minutes')::interval, 180000, track_uri, track_name, artist_name, album_name, 'trackdone'
			FROM (SELECT * FROM spotify_plays WHERE track_uri IS NOT NULL LIMIT 1) t, generate_series(1, 3) g`);
		// What the ingest runs at its end (lib/rollups.py).
		const out = execFileSync('uv', ['run', '--no-sync', 'python', '-c', 'import psycopg,sys; from lib.rollups import refresh_rollups as r; print(r(psycopg.connect(sys.argv[1]))["total_ms"])', process.env.E2E_DB!], { cwd: REPO, encoding: 'utf8' });
		expect(Number(out.trim().split('\n').at(-1))).toBeGreaterThan(0);
		const b = await request.get('/api/stats/overview', { headers: { 'If-None-Match': etag } });
		expect(b.status()).toBe(200);
		expect((await b.json()).totals.plays).toBe(before + 3);
	});

	test('R3-16 every R3 page: one h1, images have alt, buttons have names, nothing leaves localhost @both', async ({ page, blocked }) => {
		const f = await mock.fixture();
		const pages = ['/stats', '/stats/top', '/stats/patterns', '/stats/year', '/stats/records', '/stats/behaviour', '/stats/compare', '/stats/badges', '/stats/onthisday', `/track/${encodeURIComponent(f.track0)}`, `/artist/${f.artist0.id}`, '/search?q=Track'];
		for (const p of pages) {
			await page.goto(p);
			await expect(page.locator('h1').first()).toBeVisible();
			const issues = await page.evaluate(() => {
				const out: string[] = [];
				document.querySelectorAll('img').forEach((i) => !i.hasAttribute('alt') && out.push(`img without alt: ${i.src}`));
				document.querySelectorAll('button').forEach((b) => {
					const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
					if (!name && !b.closest('[inert]')) out.push(`button without a name: ${b.outerHTML.slice(0, 80)}`);
				});
				return out;
			});
			expect(issues, p).toEqual([]);
		}
		expect(blocked).toEqual([]);
	});

	test('R3-17 v1.0: Streamlit is gone — no app.py, views/ or .streamlit/, no streamlit dependency @laptop', async () => {
		for (const p of ['app.py', 'views', '.streamlit']) expect(existsSync(join(REPO, p)), p).toBe(false);
		expect(readFileSync(join(REPO, 'pyproject.toml'), 'utf8')).not.toMatch(/streamlit|pandas/);
		expect(readFileSync(join(REPO, 'uv.lock'), 'utf8')).not.toMatch(/name = "streamlit"|name = "altair"|name = "pandas"/);
	});

	test('R3-18 performance: an ingest’s refresh < 5 s, Home payload < 100 ms; daily full rebuild reported @laptop', async () => {
		const plays = sqlNum('SELECT count(*) FROM spotify_plays');
		const full = JSON.parse(sql('SELECT hub.refresh_rollups(true)'));
		// A typical ingest: ~50 new plays from the last day.
		sql(`INSERT INTO spotify_plays (played_at, ms_played, track_uri, track_name, artist_name, album_name, reason_end, platform)
			SELECT now() - (g || ' minutes')::interval, 180000, t.track_uri, t.track_name, t.artist_name, t.album_name, 'trackdone', 'iOS 17'
			FROM (SELECT * FROM spotify_plays WHERE track_uri IS NOT NULL ORDER BY played_at DESC LIMIT 1) t, generate_series(1, 50) g`);
		const inc = JSON.parse(sql('SELECT hub.refresh_rollups()'));
		const ms = JSON.parse(sql(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT hub.home_payload((now() AT TIME ZONE 'Europe/Amsterdam')::date)`))[0]['Execution Time'];
		console.log(`[perf] ${plays} plays · ingest refresh ${inc.total_ms} ms ${JSON.stringify(inc)} · daily full ${full.total_ms} ms · home_payload ${ms.toFixed(1)} ms`);
		expect(inc.days).not.toBe('full');
		expect(inc.total_ms).toBeLessThan(5000);
		expect(ms).toBeLessThan(100);
	});

	test('R3-19 incremental day rollups equal a full recompute, also after a backfilled old day @laptop', async () => {
		sql(`INSERT INTO spotify_plays (played_at, ms_played, track_uri, track_name, artist_name, album_name, reason_end, shuffle, platform)
			SELECT timestamptz '2021-03-14 20:00:00+00' + (g || ' minutes')::interval, 200000, t.track_uri, t.track_name, t.artist_name, t.album_name, 'fwdbtn', true, 'OS X 14'
			FROM (SELECT * FROM spotify_plays WHERE track_uri IS NOT NULL LIMIT 1) t, generate_series(1, 7) g`);
		const r = JSON.parse(sql('SELECT hub.refresh_rollups()'));
		expect(r.days).toBe('2021-03-14');
		const fingerprint = (table: string) => sql(`SELECT md5(string_agg(x::text, ',' ORDER BY x::text)) FROM ${table} x`);
		const before = ['hub.daily_listening', 'hub.day_track', 'hub.behaviour_daily'].map(fingerprint);
		sql('SELECT hub.refresh_rollups(true)');
		expect(['hub.daily_listening', 'hub.day_track', 'hub.behaviour_daily'].map(fingerprint)).toEqual(before);
		expect(sqlNum('SELECT sum(plays) FROM hub.daily_listening')).toBe(sqlNum('SELECT count(*) FROM unified_plays'));
	});

	test('R3-20 hours count API plays (no ms_played) at their track length, on Home and in Stats, same as Streamlit @laptop', async ({ page, request }) => {
		sql('SELECT hub.refresh_rollups(true)'); // earlier tests add plays; start from rollups that match them
		// The seed's last 30 days are API plays: ms_played is NULL, as in production.
		expect(sqlNum(`SELECT count(*) FROM spotify_plays WHERE ms_played IS NULL AND played_at >= now() - interval '7 days' AND track_uri IS NOT NULL`)).toBeGreaterThan(0);
		const ms = (where: string) => sqlNum(`SELECT coalesce(sum(coalesce(sp.ms_played, tm.duration_ms)), 0) FROM spotify_plays sp
			LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri WHERE sp.track_uri IS NOT NULL AND ${where}`);
		const h = (n: number) => Math.round((n / 3_600_000) * 10) / 10;
		const local = `(sp.played_at AT TIME ZONE 'Europe/Amsterdam')`;
		const monthMs = ms(`${local}::date >= date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam')::date AND ${local}::date <= (now() AT TIME ZONE 'Europe/Amsterdam')::date`);
		const weekMs = ms(`sp.played_at >= (date_trunc('week', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')`);
		expect(monthMs).toBeGreaterThan(0);

		const home = await (await request.get('/api/home')).json();
		expect(Math.abs(home.stats.month.hours - h(monthMs))).toBeLessThanOrEqual(0.1); // SQL numeric vs JS rounding
		expect(home.tiles.hoursThisWeek).toBe(h(weekMs));
		// Streamlit's Spotify tab (lib/listening_time.py, the SQL views/stats.py runs).
		const streamlit = JSON.parse(execFileSync('uv', ['run', '--no-sync', 'python', '-c',
			'import json,psycopg,sys; from lib.listening_time import SPOTIFY_OVERVIEW_SQL as o, SPOTIFY_HOURS_BY_YEAR_SQL as y; c=psycopg.connect(sys.argv[1]); print(json.dumps({"total": float(c.execute(o).fetchone()[1]), "years": [[a, float(b)] for a, b in c.execute(y).fetchall()]}))',
			process.env.E2E_DB!], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').at(-1)!);
		const ov = await (await request.get('/api/stats/overview')).json();
		const b = await (await request.get('/api/stats/behaviour')).json();
		expect(Math.abs(ov.totals.hours - streamlit.total)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(b.overview.hours - streamlit.total)).toBeLessThanOrEqual(0.1);
		const yr = new Map<number, number>(b.hoursByYear.map((r: { year: number; hours: number }) => [r.year, r.hours]));
		for (const [y, hrs] of streamlit.years as [number, number][]) expect(Math.abs((yr.get(y) ?? -1) - hrs), String(y)).toBeLessThanOrEqual(0.1);
		expect(yr.get(thisYear())).toBeGreaterThan(0);

		await page.goto('/home');
		const tile = (label: RegExp) => page.locator('.tile').filter({ has: page.locator('.over', { hasText: label }) }).locator('.num');
		await expect(tile(/^Hours · /)).toHaveText(`${home.stats.month.hours}h`);
		await expect(tile(/^Hours this week$/)).toHaveText(`${home.tiles.hoursThisWeek}h`);
		expect(home.stats.month.hours).toBeGreaterThan(0);
	});
});
