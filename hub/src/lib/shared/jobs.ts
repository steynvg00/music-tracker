/**
 * Hub jobs (migration 0022, R2): shared types and what the UI shows per state.
 * Lifecycle: queued → running → done | failed (Retry re-queues a failed job). The Python
 * half lives in lib/hub_jobs.py; GitHub Actions runs it via hub-jobs.yml.
 */

export type JobKind = 'reseed_daily_pick' | 'refresh_managed' | 'push_test' | 'mix_relay' | 'wrapped_build';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export const JOB_KINDS: readonly JobKind[] = ['reseed_daily_pick', 'refresh_managed', 'push_test', 'mix_relay', 'wrapped_build'];
export const MAX_ATTEMPTS = 3;
/** Same thresholds as lib/hub_jobs.py STALE_QUEUED / STALE_RUNNING. */
export const STALE_QUEUED_MS = 15 * 60 * 1000;
export const STALE_RUNNING_MS = 30 * 60 * 1000;
const SLOW_QUEUE_MS = 2 * 60 * 1000;

export interface JobRow {
	id: string;
	kind: JobKind;
	payload: Record<string, unknown>;
	status: JobStatus;
	attempts: number;
	requestedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	result: Record<string, unknown> | null;
	error: string | null;
	runUrl: string | null;
}

export interface JobView {
	label: string;
	detail: string | null;
	tone: 'info' | 'success' | 'danger';
	/** Spinner / disabled trigger button. */
	busy: boolean;
	terminal: boolean;
	canRetry: boolean;
}

export function isTerminal(status: JobStatus): boolean {
	return status === 'done' || status === 'failed';
}

function ago(fromIso: string | null, now: number): string {
	if (!fromIso) return '';
	const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
	return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function doneDetail(job: JobRow): string {
	const r = job.result ?? {};
	switch (job.kind) {
		case 'reseed_daily_pick': {
			const added = Number(r.added ?? 0);
			return added ? `${added} fresh picks added` : 'No new picks could be mixed today';
		}
		case 'refresh_managed':
			return `${Number(r.track_count ?? 0)} tracks · ${String(r.action ?? 'updated')}`;
		case 'push_test': {
			const n = Number(r.delivered ?? 0);
			return `Sent to ${n} device${n === 1 ? '' : 's'}`;
		}
		case 'mix_relay':
			return r.skipped ? 'Not needed: Rotor carried on by itself' : `Relay sent to ${Number(r.delivered ?? 0)} device(s)`;
		case 'wrapped_build':
			return r.created ? `Rotor Wrapped ${String(r.year ?? '')} is ready` : `Rotor Wrapped ${String(r.year ?? '')} was already built`;
	}
}

/** What the UI shows for a job in each state (tested in jobs.test.ts). */
export function describeJob(job: JobRow, now: number = Date.now()): JobView {
	switch (job.status) {
		case 'queued': {
			const slow = now - Date.parse(job.requestedAt) > SLOW_QUEUE_MS;
			return {
				label: 'Queued',
				detail: slow ? 'Still waiting for GitHub Actions to start it…' : 'Waiting for GitHub Actions, usually under a minute',
				tone: 'info',
				busy: true,
				terminal: false,
				canRetry: false
			};
		}
		case 'running':
			return {
				label: 'Running',
				detail: `Started ${ago(job.startedAt, now)} ago${job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}`,
				tone: 'info',
				busy: true,
				terminal: false,
				canRetry: false
			};
		case 'done':
			return { label: 'Done', detail: doneDetail(job), tone: 'success', busy: false, terminal: true, canRetry: false };
		case 'failed':
			return {
				label: 'Failed',
				detail: job.error ?? 'Unknown error',
				tone: 'danger',
				busy: false,
				terminal: true,
				canRetry: job.attempts < MAX_ATTEMPTS
			};
	}
}

export const JOB_KIND_LABEL: Record<JobKind, string> = {
	reseed_daily_pick: 'Shuffle the deck',
	refresh_managed: 'Refresh playlist',
	push_test: 'Test notification',
	mix_relay: 'Mix relay',
	wrapped_build: 'Build Rotor Wrapped'
};
