import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DispatchFailed, JobsUnavailable, RetryRefused, dispatch, enqueue, enqueueAndDispatch, getJob, retry } from './jobs';
import { describeJob, MAX_ATTEMPTS, type JobRow } from '$lib/shared/jobs';
import { fakeFetch, fakeSql } from './test-helpers';
import { toResponse } from './http';

const cfg = { githubDispatchToken: 'pat-not-real', githubRepository: 'steynvg00/music-tracker' };
const ID = '0b5e2c1a-7f1d-4c2e-9a3b-123456789abc';

function dbJob(over: Partial<Record<string, unknown>> = {}) {
	return {
		id: ID,
		kind: 'refresh_managed',
		payload: { playlist_id: 'x' },
		status: 'queued',
		attempts: 0,
		requested_at: new Date('2026-11-05T10:00:00Z'),
		started_at: null,
		finished_at: null,
		result: null,
		error: null,
		run_url: null,
		...over
	};
}

function gh(status = 204) {
	return fakeFetch(() => ({ status }));
}

describe('enqueue (idempotent per dedupe_key)', () => {
	it('creates a new job', async () => {
		const { sql, queries } = fakeSql((q) => (q.text.startsWith('INSERT INTO hub_jobs') ? [dbJob()] : []));
		const r = await enqueue(sql, 'refresh_managed', { playlist_id: 'x' }, 'refresh:x');
		expect(r).toMatchObject({ created: true, job: { id: ID, status: 'queued' } });
		expect(queries[0]!.text).toContain("ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING");
	});
	it('returns the active job instead of a second one', async () => {
		const { sql } = fakeSql((q) => (q.text.startsWith('SELECT * FROM hub_jobs WHERE dedupe_key') ? [dbJob({ status: 'running' })] : []));
		const r = await enqueue(sql, 'refresh_managed', { playlist_id: 'x' }, 'refresh:x');
		expect(r).toMatchObject({ created: false, job: { status: 'running' } });
	});
});

describe('JSON parameters reach Postgres as objects', () => {
	it('enqueue sends the payload as text and casts it, so jsonb holds an object', async () => {
		const { sql, queries } = fakeSql((q) => (q.text.startsWith('INSERT INTO hub_jobs') ? [dbJob()] : []));
		await enqueue(sql, 'refresh_managed', { playlist_id: 'x' }, 'refresh:x');
		expect(queries[0]!.text).toContain('$::text::jsonb');
		expect(queries[0]!.values[1]).toBe('{"playlist_id":"x"}');
	});
	it('no server file binds a parameter straight to ::jsonb (postgres.js would encode the string twice)', () => {
		const dir = fileURLToPath(new URL('.', import.meta.url));
		const files: string[] = [];
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const f = join(d, e.name);
				if (e.isDirectory()) walk(f);
				else if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(f);
			}
		};
		walk(dir);
		const bad = files.filter((f) => /\}::jsonb?\b/.test(readFileSync(f, 'utf8')));
		expect(files.length).toBeGreaterThan(10);
		expect(bad).toEqual([]);
	});
});

describe('dispatch', () => {
	it('starts hub-jobs.yml on main with the job id and the PAT', async () => {
		const f = gh();
		await dispatch(cfg, ID, f.fetch);
		const c = f.calls[0]!;
		expect(c.url.href).toBe('https://api.github.com/repos/steynvg00/music-tracker/actions/workflows/hub-jobs.yml/dispatches');
		expect(c.body).toEqual({ ref: 'main', inputs: { job_id: ID } });
		expect(c.headers.Authorization).toBe('Bearer pat-not-real');
	});
	it('needs a token', async () => {
		await expect(dispatch({ ...cfg, githubDispatchToken: null }, ID)).rejects.toBeInstanceOf(JobsUnavailable);
	});
	it('rejects non-204', async () => {
		await expect(dispatch(cfg, ID, gh(404).fetch)).rejects.toBeInstanceOf(DispatchFailed);
	});
});

describe('enqueueAndDispatch', () => {
	it('a failed dispatch marks the job failed right away (UI shows Retry)', async () => {
		const { sql, queries } = fakeSql((q) => {
			if (q.text.startsWith('INSERT INTO hub_jobs')) return [dbJob()];
			if (q.text.startsWith("UPDATE hub_jobs SET status = 'failed'")) return [dbJob({ status: 'failed', error: q.values[0] })];
			return [];
		});
		const r = await enqueueAndDispatch(sql, cfg, 'refresh_managed', {}, 'refresh:x', gh(422).fetch);
		expect(r.job).toMatchObject({ status: 'failed', error: 'GitHub workflow dispatch failed: HTTP 422' });
		expect(queries.some((q) => q.text.startsWith("UPDATE hub_jobs SET status = 'failed'"))).toBe(true);
	});
	it('does not dispatch again for an already-active job', async () => {
		const f = gh();
		const { sql } = fakeSql((q) => (q.text.startsWith('SELECT * FROM hub_jobs WHERE dedupe_key') ? [dbJob({ status: 'queued' })] : []));
		await enqueueAndDispatch(sql, cfg, 'refresh_managed', {}, 'refresh:x', f.fetch);
		expect(f.calls).toHaveLength(0);
	});
	it('without a token: JobsUnavailable → 409 jobs_unavailable', async () => {
		const { sql } = fakeSql(() => []);
		const e = await enqueueAndDispatch(sql, { ...cfg, githubDispatchToken: null }, 'push_test', {}, null).catch((x) => x);
		expect(e).toBeInstanceOf(JobsUnavailable);
		const res = toResponse(e);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: 'jobs_unavailable' });
	});
});

describe('getJob applies the stale rule first', () => {
	it('issues the stale UPDATE (15 min queued / 30 min running) before reading', async () => {
		const { sql, queries } = fakeSql((q) => (q.text.startsWith('SELECT * FROM hub_jobs WHERE id') ? [dbJob({ status: 'failed', error: 'stale: no runner picked the job up' })] : []));
		const j = await getJob(sql, ID);
		expect(queries[0]!.text).toContain("stale: no runner picked the job up");
		expect(queries[0]!.values).toContain(900);
		expect(queries[0]!.values).toContain(1800);
		expect(j?.status).toBe('failed');
	});
});

describe('retry', () => {
	const read = (row: Record<string, unknown>) => (q: { text: string }) => (q.text.startsWith('SELECT * FROM hub_jobs WHERE id') ? [row] : undefined);
	it('re-queues a failed job and dispatches it again', async () => {
		const f = gh();
		const { sql, queries } = fakeSql((q) => read(dbJob({ status: 'failed', attempts: 1 }))(q) ?? (q.text.startsWith("UPDATE hub_jobs SET status = 'queued'") ? [dbJob({ status: 'queued', attempts: 1 })] : []));
		const j = await retry(sql, cfg, ID, f.fetch);
		expect(j.status).toBe('queued');
		expect(queries.some((q) => q.text.startsWith("UPDATE hub_jobs SET status = 'queued'"))).toBe(true);
		expect(f.calls).toHaveLength(1);
	});
	it.each([
		[{ status: 'running' }, 'not_failed'],
		[{ status: 'done' }, 'not_failed'],
		[{ status: 'failed', attempts: MAX_ATTEMPTS }, 'max_attempts']
	])('refuses %o', async (over, reason) => {
		const { sql } = fakeSql((q) => read(dbJob(over))(q) ?? []);
		const e = await retry(sql, cfg, ID, gh().fetch).catch((x) => x);
		expect(e).toBeInstanceOf(RetryRefused);
		expect(e.reason).toBe(reason);
		expect(toResponse(e).status).toBe(409);
	});
	it('unknown job → not_found', async () => {
		const { sql } = fakeSql(() => []);
		await expect(retry(sql, cfg, ID, gh().fetch)).rejects.toMatchObject({ reason: 'not_found' });
	});
});

describe('describeJob: what the UI shows per state', () => {
	const base: JobRow = {
		id: ID,
		kind: 'refresh_managed',
		payload: {},
		status: 'queued',
		attempts: 0,
		requestedAt: '2026-11-05T10:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
		runUrl: null
	};
	const t0 = Date.parse(base.requestedAt);
	it('queued: busy, info; turns into "still waiting" after 2 minutes', () => {
		expect(describeJob(base, t0 + 10_000)).toMatchObject({ label: 'Queued', busy: true, tone: 'info', terminal: false, canRetry: false });
		expect(describeJob(base, t0 + 10_000).detail).toMatch(/usually under a minute/);
		expect(describeJob(base, t0 + 180_000).detail).toMatch(/Still waiting/);
	});
	it('running: shows elapsed time and the attempt number on retries', () => {
		const v = describeJob({ ...base, status: 'running', startedAt: '2026-11-05T10:00:05.000Z', attempts: 2 }, t0 + 35_000);
		expect(v).toMatchObject({ label: 'Running', busy: true });
		expect(v.detail).toBe('Started 30 s ago · attempt 2');
	});
	it('done: a result line per kind', () => {
		expect(describeJob({ ...base, status: 'done', result: { track_count: 30, action: 'updated' } }).detail).toBe('30 tracks · updated');
		expect(describeJob({ ...base, kind: 'reseed_daily_pick', status: 'done', result: { added: 5 } }).detail).toBe('5 fresh picks added');
		expect(describeJob({ ...base, kind: 'reseed_daily_pick', status: 'done', result: { added: 0 } }).detail).toBe('No new picks could be mixed today');
		expect(describeJob({ ...base, kind: 'push_test', status: 'done', result: { delivered: 1 } }).detail).toBe('Sent to 1 device');
		expect(describeJob({ ...base, status: 'done', result: {} })).toMatchObject({ tone: 'success', terminal: true, busy: false });
	});
	it('failed: shows the error; Retry until the attempt limit', () => {
		expect(describeJob({ ...base, status: 'failed', attempts: 1, error: 'boom' })).toMatchObject({ label: 'Failed', detail: 'boom', tone: 'danger', canRetry: true });
		expect(describeJob({ ...base, status: 'failed', attempts: MAX_ATTEMPTS, error: 'boom' }).canRetry).toBe(false);
	});
});
