/**
 * Hub job queue, server side (04-architecture.md §4, R2).
 *
 *   enqueue()   INSERT hub_jobs (queued). One active job per dedupe_key: a second
 *               "Refresh now" while one is queued/running returns the existing job.
 *   dispatch()  POST …/actions/workflows/hub-jobs.yml/dispatches { job_id } with
 *               GITHUB_DISPATCH_TOKEN. A failed dispatch marks the job failed at once.
 *   getJob()    reads a job; queued > 15 min or running > 30 min → failed (stale).
 *   retry()     failed → queued + dispatch again, up to MAX_ATTEMPTS claims.
 * scripts/run_hub_job.py claims the row (queued → running), runs it and reports back.
 */
import type { Queryable } from '$lib/server/db';
import type { HubConfig } from '$lib/server/env';
import { MAX_ATTEMPTS, STALE_QUEUED_MS, STALE_RUNNING_MS, type JobKind, type JobRow } from '$lib/shared/jobs';

export const JOB_WORKFLOW = 'hub-jobs.yml';

interface DbJob {
	id: string;
	kind: JobKind;
	payload: Record<string, unknown> | null;
	status: JobRow['status'];
	attempts: number;
	requested_at: Date;
	started_at: Date | null;
	finished_at: Date | null;
	result: Record<string, unknown> | null;
	error: string | null;
	run_url: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function toJob(r: DbJob): JobRow {
	return {
		id: r.id,
		kind: r.kind,
		payload: r.payload ?? {},
		status: r.status,
		attempts: r.attempts,
		requestedAt: new Date(r.requested_at).toISOString(),
		startedAt: iso(r.started_at),
		finishedAt: iso(r.finished_at),
		result: r.result,
		error: r.error,
		runUrl: r.run_url
	};
}

export class JobsUnavailable extends Error {
	constructor() {
		super('Jobs need GITHUB_DISPATCH_TOKEN in the Vercel env');
		this.name = 'JobsUnavailable';
	}
}

export class DispatchFailed extends Error {
	constructor(readonly status: number) {
		super(`GitHub workflow dispatch failed: HTTP ${status}`);
		this.name = 'DispatchFailed';
	}
}

export function jobsAvailable(cfg: Pick<HubConfig, 'githubDispatchToken'>): boolean {
	return !!cfg.githubDispatchToken;
}

export async function enqueue(
	sql: Queryable,
	kind: JobKind,
	payload: Record<string, unknown>,
	dedupeKey: string | null
): Promise<{ job: JobRow; created: boolean }> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const inserted = await sql<DbJob[]>`
			INSERT INTO hub_jobs (kind, payload, dedupe_key)
			VALUES (${kind}, ${JSON.stringify(payload)}::text::jsonb, ${dedupeKey})
			ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
			RETURNING *`;
		if (inserted[0]) return { job: toJob(inserted[0]), created: true };
		const active = await sql<DbJob[]>`
			SELECT * FROM hub_jobs WHERE dedupe_key = ${dedupeKey} AND status IN ('queued', 'running')`;
		if (active[0]) return { job: toJob(active[0]), created: false };
		// The active one finished between the two statements: insert again.
	}
	throw new Error('could not enqueue job');
}

export async function dispatch(
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	jobId: string,
	f: typeof fetch = fetch
): Promise<void> {
	if (!cfg.githubDispatchToken) throw new JobsUnavailable();
	const res = await f(`https://api.github.com/repos/${cfg.githubRepository}/actions/workflows/${JOB_WORKFLOW}/dispatches`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${cfg.githubDispatchToken}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'rotor-hub',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ ref: 'main', inputs: { job_id: jobId } }),
		signal: AbortSignal.timeout(8000)
	});
	if (res.status !== 204) throw new DispatchFailed(res.status);
}

async function markFailed(sql: Queryable, id: string, error: string): Promise<JobRow | null> {
	const [r] = await sql<DbJob[]>`
		UPDATE hub_jobs SET status = 'failed', finished_at = now(), error = ${error.slice(0, 500)}
		WHERE id = ${id} AND status IN ('queued', 'running') RETURNING *`;
	return r ? toJob(r) : null;
}

/** Enqueue + dispatch. An already-active job with the same key is returned as-is (no second run). */
export async function enqueueAndDispatch(
	sql: Queryable,
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	kind: JobKind,
	payload: Record<string, unknown>,
	dedupeKey: string | null,
	f: typeof fetch = fetch
): Promise<{ job: JobRow; created: boolean }> {
	if (!jobsAvailable(cfg)) throw new JobsUnavailable();
	const { job, created } = await enqueue(sql, kind, payload, dedupeKey);
	if (!created) return { job, created };
	try {
		await dispatch(cfg, job.id, f);
		return { job, created };
	} catch (e) {
		const failed = await markFailed(sql, job.id, e instanceof Error ? e.message : String(e));
		return { job: failed ?? job, created };
	}
}

/** One job, with the stale rule applied first so the UI never spins forever. */
export async function getJob(sql: Queryable, id: string): Promise<JobRow | null> {
	await sql`
		UPDATE hub_jobs SET status = 'failed', finished_at = now(),
			error = CASE WHEN status = 'queued' THEN 'stale: no runner picked the job up'
			             ELSE 'stale: the run stopped without reporting back' END
		WHERE id = ${id}
		  AND ((status = 'queued' AND requested_at < now() - make_interval(secs => ${STALE_QUEUED_MS / 1000}))
		    OR (status = 'running' AND started_at < now() - make_interval(secs => ${STALE_RUNNING_MS / 1000})))`;
	const [r] = await sql<DbJob[]>`SELECT * FROM hub_jobs WHERE id = ${id}`;
	return r ? toJob(r) : null;
}

export class RetryRefused extends Error {
	constructor(readonly reason: 'not_found' | 'not_failed' | 'max_attempts') {
		super(`Retry refused: ${reason}`);
		this.name = 'RetryRefused';
	}
}

export async function retry(
	sql: Queryable,
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	id: string,
	f: typeof fetch = fetch
): Promise<JobRow> {
	if (!jobsAvailable(cfg)) throw new JobsUnavailable();
	const current = await getJob(sql, id);
	if (!current) throw new RetryRefused('not_found');
	if (current.status !== 'failed') throw new RetryRefused('not_failed');
	if (current.attempts >= MAX_ATTEMPTS) throw new RetryRefused('max_attempts');
	let requeued: DbJob | undefined;
	try {
		[requeued] = await sql<DbJob[]>`
			UPDATE hub_jobs SET status = 'queued', requested_at = now(), started_at = NULL, finished_at = NULL, error = NULL
			WHERE id = ${id} AND status = 'failed' RETURNING *`;
	} catch (e) {
		// Unique violation: another job with the same dedupe_key is already active. Show that one.
		if ((e as { code?: string }).code !== '23505') throw e;
		const [active] = await sql<DbJob[]>`
			SELECT a.* FROM hub_jobs a JOIN hub_jobs j ON j.dedupe_key = a.dedupe_key
			WHERE j.id = ${id} AND a.status IN ('queued', 'running')`;
		if (active) return toJob(active);
		throw e;
	}
	if (!requeued) throw new RetryRefused('not_failed');
	try {
		await dispatch(cfg, id, f);
	} catch (e) {
		return (await markFailed(sql, id, e instanceof Error ? e.message : String(e))) ?? toJob(requeued);
	}
	return toJob(requeued);
}

export async function recentJobs(sql: Queryable, limit = 10): Promise<JobRow[]> {
	const rows = await sql<DbJob[]>`SELECT * FROM hub_jobs ORDER BY requested_at DESC LIMIT ${limit}`;
	return rows.map(toJob);
}

/** Latest refresh job for one playlist (playlist detail shows its state). */
export async function latestPlaylistJob(sql: Queryable, playlistId: string): Promise<JobRow | null> {
	const [r] = await sql<{ id: string }[]>`
		SELECT id FROM hub_jobs WHERE kind = 'refresh_managed' AND payload->>'playlist_id' = ${playlistId}
		ORDER BY requested_at DESC LIMIT 1`;
	return r ? getJob(sql, r.id) : null;
}
