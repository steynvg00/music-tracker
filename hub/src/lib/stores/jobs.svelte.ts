/** Follows one hub job in the UI: polls /api/jobs/{id} every 3 s while it's active and the tab is visible. */
import { browser } from '$app/environment';
import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
import { describeJob, isTerminal, type JobRow } from '$lib/shared/jobs';
import { toasts } from './toasts.svelte';

const POLL_MS = 3000;

export class JobTracker {
	job = $state<JobRow | null>(null);
	now = $state(Date.now());
	view = $derived(this.job ? describeJob(this.job, this.now) : null);

	#timer: ReturnType<typeof setTimeout> | undefined;
	#onDone: ((job: JobRow) => void) | undefined;
	#onVisible: (() => void) | undefined;

	constructor(onDone?: (job: JobRow) => void) {
		this.#onDone = onDone;
	}

	/** Start following a job (from an enqueue/retry response or a page load). */
	track(job: JobRow | null): void {
		this.#cancel();
		this.job = job;
		if (job && !isTerminal(job.status)) this.#schedule();
	}

	#schedule(): void {
		if (!browser) return;
		this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
	}

	async #poll(): Promise<void> {
		const j = this.job;
		if (!j) return;
		if (document.visibilityState !== 'visible') {
			// No requests while hidden; pick up again when the tab is shown.
			if (!this.#onVisible) {
				this.#onVisible = () => {
					this.#onVisible = undefined;
					void this.#poll();
				};
				document.addEventListener('visibilitychange', this.#onVisible, { once: true });
			}
			return;
		}
		try {
			const fresh = await apiGet<JobRow>(`/api/jobs/${j.id}`);
			this.now = Date.now();
			const wasActive = !isTerminal(j.status);
			this.job = fresh;
			if (!isTerminal(fresh.status)) this.#schedule();
			else if (wasActive) this.#onDone?.(fresh);
		} catch {
			this.#schedule();
		}
	}

	async retry(): Promise<void> {
		if (!this.job) return;
		try {
			this.track(await apiPost<JobRow>(`/api/jobs/${this.job.id}/retry`));
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}

	stop(): void {
		this.#cancel();
	}

	/** Clears the timer AND a pending visibility listener, so a stopped tracker stays stopped. */
	#cancel(): void {
		clearTimeout(this.#timer);
		if (this.#onVisible && browser) document.removeEventListener('visibilitychange', this.#onVisible);
		this.#onVisible = undefined;
	}
}
