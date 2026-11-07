/**
 * R8 parity gaps: Data health rules, the GitHub cron reader (fetch mocked: never the real API),
 * the scheduled-workflow list against .github/workflows, the phantom-plays population against
 * Streamlit's, the digest's arrows/weeks, the skeleton routing, and the bypass scan over every
 * new R8 module.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch, fakeSql } from './test-helpers';
import { clearCronCache, cronHealth } from './github-health';
import { PHANTOM_WHERE_SQL } from './phantom';
import { digestPayload } from './digest';
import { ago, autoDisableAt, daysUntil, dbTone, fmtBytes, freshnessTone, SCHEDULED_WORKFLOWS, workflowTone, DB_CAP_BYTES, DB_WARN_BYTES } from '$lib/shared/health';
import { arrowFor, isWeek, mondayOf, showArrows, weekLabel } from '$lib/shared/digest';
import { skeletonFor } from '$lib/shared/skeleton';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-11-07T12:00:00Z');
const CFG = { githubDispatchToken: 'gh-test-token', githubRepository: 'owner/repo' };

describe('health rules', () => {
	it('auto-disable = max(last push, last good keepalive) + 60 days', () => {
		expect(autoDisableAt('2026-09-29T10:00:00Z', '2026-11-02T07:20:00Z')).toBe('2027-01-01T07:20:00.000Z');
		expect(autoDisableAt('2026-11-05T00:00:00Z', '2026-11-02T07:20:00Z')).toBe('2027-01-04T00:00:00.000Z');
		expect(autoDisableAt(null, null)).toBeNull();
		expect(daysUntil('2027-01-01T07:20:00.000Z', NOW)).toBe(54);
	});
	it('freshness: ok ≤ 1.5× the cadence, late ≤ 3×, then a problem; info without a cadence', () => {
		const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
		expect(freshnessTone(h(1), 1, NOW)).toBe('ok');
		expect(freshnessTone(h(2), 1, NOW)).toBe('warn');
		expect(freshnessTone(h(4), 1, NOW)).toBe('danger');
		expect(freshnessTone(null, 24, NOW)).toBe('danger');
		expect(freshnessTone(null, null, NOW)).toBe('info');
	});
	it('workflow tone: disabled or < 7 days is a problem; a failed last run or < 21 days is late', () => {
		expect(workflowTone('disabled_inactivity', 'success', 40)).toBe('danger');
		expect(workflowTone('active', 'success', 5)).toBe('danger');
		expect(workflowTone('active', 'failure', 40)).toBe('warn');
		expect(workflowTone('active', 'success', 15)).toBe('warn');
		expect(workflowTone('active', 'success', 40)).toBe('ok');
		expect(workflowTone(null, null, null)).toBe('info');
	});
	it('database size against the 500 MB cap', () => {
		expect(dbTone(100 * 1024 * 1024)).toBe('ok');
		expect(dbTone(0.8 * DB_CAP_BYTES)).toBe('warn');
		expect(dbTone(0.95 * DB_CAP_BYTES)).toBe('danger');
		// v0.90: an explicit warning above 450 MB (the production DB was at 417 MB).
		expect(DB_WARN_BYTES).toBe(450 * 1024 * 1024);
		expect(dbTone(417 * 1024 * 1024)).toBe('warn');
		expect(dbTone(DB_WARN_BYTES + 1)).toBe('danger');
		expect(fmtBytes(123 * 1024 * 1024)).toBe('123.0 MB');
		expect(fmtBytes(2048)).toBe('2 kB');
	});
	it('relative times', () => {
		expect(ago(null, NOW)).toBe('never');
		expect(ago(new Date(NOW.getTime() - 5 * 60000).toISOString(), NOW)).toBe('5 min ago');
		expect(ago(new Date(NOW.getTime() - 5 * 3_600_000).toISOString(), NOW)).toBe('5 h ago');
		expect(ago(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW)).toBe('3 d ago');
	});
});

describe('scheduled workflows', () => {
	it('SCHEDULED_WORKFLOWS lists exactly the workflow files that have a schedule: trigger', () => {
		const dir = join(REPO_ROOT, '.github/workflows');
		const scheduled = readdirSync(dir)
			.filter((f) => /\.ya?ml$/.test(f))
			.filter((f) => /^\s*schedule:\s*$/m.test(readFileSync(join(dir, f), 'utf8')))
			.sort();
		expect(SCHEDULED_WORKFLOWS.map((w) => w.file).sort()).toEqual(scheduled);
	});
	it('keepalive re-enables every scheduled workflow (the auto-disable rule relies on it)', () => {
		const ka = readFileSync(join(REPO_ROOT, '.github/workflows/keepalive.yml'), 'utf8');
		const list = /WORKFLOWS:\s*(.+)/.exec(ka)?.[1]?.trim().split(/\s+/) ?? [];
		expect(list.sort()).toEqual(SCHEDULED_WORKFLOWS.map((w) => w.file).sort());
	});
});

describe('cron health from the GitHub API (mocked)', () => {
	beforeEach(() => clearCronCache());
	const runs = (r: Record<string, unknown>[]) => ({ status: 200, body: { workflow_runs: r } });
	const route = (over: { repo?: unknown; status?: number } = {}) =>
		fakeFetch((req) => {
			const p = req.url.pathname;
			if (over.status) return { status: over.status, body: { message: 'Bad credentials' } };
			if (p === '/repos/owner/repo') return { status: 200, body: over.repo ?? { pushed_at: '2026-09-29T10:00:00Z', private: false } };
			if (p === '/repos/owner/repo/actions/workflows')
				return {
					status: 200,
					body: {
						workflows: [
							{ path: '.github/workflows/scheduled-ingest.yml', state: 'active' },
							{ path: '.github/workflows/hub-jobs.yml', state: 'active' },
							{ path: '.github/workflows/ingest-monitor.yml', state: 'disabled_inactivity' },
							{ path: '.github/workflows/keepalive.yml', state: 'active' },
							{ path: '.github/workflows/ci.yml', state: 'active' }
						]
					}
				};
			if (p.endsWith('/keepalive.yml/runs'))
				return runs([
					{ created_at: '2026-11-07T07:17:00Z', conclusion: 'failure', status: 'completed', event: 'schedule', html_url: 'https://github.com/x/1' },
					{ created_at: '2026-11-02T07:17:00Z', updated_at: '2026-11-02T07:20:00Z', conclusion: 'success', status: 'completed', event: 'schedule', html_url: 'https://github.com/x/2' }
				]);
			if (p.endsWith('/runs')) return runs([{ created_at: '2026-11-07T11:30:00Z', conclusion: 'success', status: 'completed', event: 'schedule', html_url: 'https://github.com/x/3' }]);
			return undefined;
		});

	it('no token → every value unknown, and no request is made', async () => {
		const f = route();
		const h = await cronHealth({ githubDispatchToken: null, githubRepository: 'owner/repo' }, f.fetch, NOW);
		expect(h.known).toBe(false);
		expect(h.reason).toMatch(/GITHUB_DISPATCH_TOKEN/);
		expect(h.workflows.every((w) => w.autoDisableAt === null && w.state === null)).toBe(true);
		expect(f.calls).toHaveLength(0);
	});

	it('reads state, last runs and the auto-disable date with GET requests only', async () => {
		const f = route();
		const h = await cronHealth(CFG, f.fetch, NOW);
		expect(h.known).toBe(true);
		expect(h.lastKeepaliveAt).toBe('2026-11-02T07:20:00Z'); // the last SUCCESSFUL keepalive
		expect(h.autoDisableAt).toBe('2027-01-01T07:20:00.000Z');
		expect(h.daysLeft).toBe(54);
		const by = Object.fromEntries(h.workflows.map((w) => [w.file, w]));
		expect(by['scheduled-ingest.yml']!.state).toBe('active');
		expect(by['scheduled-ingest.yml']!.autoDisableAt).toBe('2027-01-01T07:20:00.000Z');
		expect(by['ingest-monitor.yml']!.tone).toBe('danger');
		expect(by['ingest-monitor.yml']!.autoDisableAt).toBeNull();
		expect(by['keepalive.yml']!.lastConclusion).toBe('failure');
		expect(by['keepalive.yml']!.tone).toBe('warn');
		expect(f.calls.every((c) => c.method === 'GET' && c.url.host === 'api.github.com')).toBe(true);
		expect(f.calls.every((c) => c.headers.Authorization === 'Bearer gh-test-token')).toBe(true);
		expect(f.calls).toHaveLength(2 + SCHEDULED_WORKFLOWS.length);
	});

	it('is cached for 5 minutes', async () => {
		const f = route();
		await cronHealth(CFG, f.fetch, NOW);
		await cronHealth(CFG, f.fetch, new Date(NOW.getTime() + 4 * 60000));
		expect(f.calls).toHaveLength(2 + SCHEDULED_WORKFLOWS.length);
		await cronHealth(CFG, f.fetch, new Date(NOW.getTime() + 6 * 60000));
		expect(f.calls).toHaveLength(2 * (2 + SCHEDULED_WORKFLOWS.length));
	});

	it('a refused token → unknown with the reason', async () => {
		const h = await cronHealth(CFG, route({ status: 403 }).fetch, NOW);
		expect(h.known).toBe(false);
		expect(h.reason).toMatch(/refused the token \(403\)/);
	});

	it('a private repository is not subject to the 60-day rule', async () => {
		const h = await cronHealth(CFG, route({ repo: { pushed_at: '2026-01-01T00:00:00Z', private: true } }).fetch, NOW);
		expect(h.known).toBe(true);
		expect(h.autoDisableAt).toBeNull();
		expect(h.reason).toMatch(/Private repository/);
	});
});

describe('phantom plays', () => {
	it('uses exactly Streamlit’s population in every query', () => {
		const streamlit = join(REPO_ROOT, 'views/_stats_phantom_plays.py');
		if (existsSync(streamlit)) {
			const py = readFileSync(streamlit, 'utf8');
			expect(py).toContain(`_WHERE = "WHERE ${PHANTOM_WHERE_SQL}"`);
		}
		const ts = readFileSync(join(SRC, 'lib/server/phantom.ts'), 'utf8');
		// Every read of the population (summary, by month, by platform, by reason end, the list,
		// phantomSummary) is `FROM spotify_plays WHERE <the predicate>`; the only other reads are
		// the two neighbour lookups (`FROM spotify_plays s`), which look for IDENTIFIED tracks.
		const all = ts.match(/FROM spotify_plays\b(?! s\b)/g) ?? [];
		const filtered = ts.match(new RegExp(`FROM spotify_plays\\s+WHERE ${PHANTOM_WHERE_SQL}`, 'g')) ?? [];
		expect(all.length).toBe(6);
		expect(filtered.length).toBe(6);
		expect(ts.match(/FROM spotify_plays s\b/g)?.length).toBe(2);
	});
});

describe('digest', () => {
	it('arrows match the mail', () => {
		expect(arrowFor(3, null)).toEqual({ label: '★ NEW', dir: 'new' });
		expect(arrowFor(1, 4)).toEqual({ label: '↑ 3', dir: 'up' });
		expect(arrowFor(5, 2)).toEqual({ label: '↓ 3', dir: 'down' });
		expect(arrowFor(2, 2)).toEqual({ label: '—', dir: 'same' });
		expect(showArrows([{ rank: 1, prev: 1 }], true)).toBe(false); // nothing moved → no column
		expect(showArrows([{ rank: 1, prev: 2 }], false)).toBe(false); // no baseline → no column
		expect(showArrows([{ rank: 1, prev: null }], true)).toBe(true);
	});
	it('weeks are Mondays', () => {
		expect(mondayOf('2026-11-07')).toBe('2026-11-02');
		expect(mondayOf('2026-11-02')).toBe('2026-11-02');
		expect(isWeek('2026-11-02')).toBe(true);
		expect(isWeek('2026-11-03')).toBe(false);
		expect(isWeek("2026-11-02'; DROP")).toBe(false);
		expect(weekLabel('2026-11-02')).toBe('Week of 2 Nov 2026');
	});
	it('without 0029 it still answers, from rank history only', async () => {
		const { sql, queries } = fakeSql((q) => {
			if (q.text.includes('FROM digest_runs')) throw Object.assign(new Error('relation "digest_runs" does not exist'), { code: '42P01' });
			if (q.text.includes('count(DISTINCT playlist_id)')) return [{ week: '2026-11-02', changed: 2 }, { week: '2026-10-26', changed: 2 }];
			return [];
		});
		const d = await digestPayload(sql, null, '2026-11-07');
		expect(d.storing).toBe(false);
		expect(d.week).toBe('2026-11-02');
		expect(d.prev).toBe('2026-10-26');
		expect(d.next).toBeNull();
		expect(d.weeks.every((w) => !w.stored)).toBe(true);
		expect(queries.some((q) => q.text.includes('WITH latest AS'))).toBe(true);
	});
	it('an unknown week falls back to the newest one; a bad value is never put in SQL', async () => {
		const { sql, queries } = fakeSql((q) => (q.text.includes('count(DISTINCT playlist_id)') ? [{ week: '2026-11-02', changed: 1 }] : []));
		const d = await digestPayload(sql, 'nonsense', '2026-11-07');
		expect(d.week).toBe('2026-11-02');
		expect(queries.flatMap((q) => q.values).includes('nonsense')).toBe(false);
	});
});

describe('skeletons', () => {
	it('every R8 skeleton route maps to its shape; same-route links and detail pages get none', () => {
		expect(skeletonFor('/home')).toBe('home');
		expect(skeletonFor('/stats')).toBe('stats');
		expect(skeletonFor('/stats/top')).toBe('stats');
		expect(skeletonFor('/library')).toBe('library');
		expect(skeletonFor('/wrapped/2026')).toBe('wrapped');
		expect(skeletonFor('/radar')).toBe('radar');
		expect(skeletonFor('/digest')).toBe('list');
		expect(skeletonFor('/settings/health/phantom')).toBe('list');
		expect(skeletonFor('/settings')).toBeNull();
		expect(skeletonFor('/track/spotify:track:x')).toBeNull();
	});
});

describe('bypass scan covers R8 modules', () => {
	it('no R8 module touches Spotify or a write path; GitHub is read-only', () => {
		const scanned: string[] = [];
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
					const rel = relative(SRC, p).replaceAll('\\', '/');
					scanned.push(rel);
					const text = readFileSync(p, 'utf8');
					if (rel !== 'lib/server/spotify/write-guard.ts' && rel !== 'lib/server/spotify/api.ts' && text.includes('_sendPlaylistWrite')) offenders.push(rel);
					if (!['lib/server/spotify/api.ts', 'lib/server/spotify/oauth.ts'].includes(rel) && /api\.spotify\.com/.test(text)) offenders.push(rel);
					if (rel === 'lib/server/github-health.ts' && /method:\s*'(POST|PUT|PATCH|DELETE)'/.test(text)) offenders.push(`${rel} (must only GET)`);
				}
			}
		};
		walk(SRC);
		for (const f of [
			'lib/server/health.ts',
			'lib/server/github-health.ts',
			'lib/server/phantom.ts',
			'lib/server/digest.ts',
			'lib/shared/health.ts',
			'lib/shared/digest.ts',
			'lib/shared/skeleton.ts',
			'lib/components/RouteSkeleton.svelte',
			'routes/api/health/+server.ts',
			'routes/api/health/phantom/+server.ts',
			'routes/api/digest/+server.ts',
			'routes/(app)/settings/health/+page.svelte',
			'routes/(app)/settings/health/phantom/+page.svelte',
			'routes/(app)/digest/+page.svelte'
		]) {
			expect(scanned).toContain(f);
		}
		expect(offenders).toEqual([]);
	});
});
