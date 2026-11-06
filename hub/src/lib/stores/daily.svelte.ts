/** Today's deck, shared by Home's hero, the daily-pick detail and the sidebar. */
import { browser } from '$app/environment';
import type { DailyDeck } from '$lib/shared/daily-types';
import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
import { player } from './player.svelte';
import { toasts } from './toasts.svelte';
import { JobTracker } from './jobs.svelte';
import { MAX_ATTEMPTS, type JobRow } from '$lib/shared/jobs';

const MIN_SKELETON_MS = 300;

type MoveResponse = { result: { ok: boolean; reason?: string }; deck: DailyDeck };

class DailyStore {
	deck = $state<DailyDeck | null>(null);
	rotating = $state(false);
	/** "Shuffle the deck" job of the shown day. */
	reseedJob = new JobTracker((job) => {
		if (job.status === 'done') {
			const added = Number(job.result?.added ?? 0);
			void this.reload().then(() => toasts.show(added ? `${added} fresh picks are ready` : 'No new picks could be mixed today'));
		} else this.#failed(job);
	});
	reseeding = $derived(!!this.reseedJob.view?.busy);

	current = $derived(this.deck?.current ?? null);
	isLast = $derived(!!this.current && !!this.deck && this.current.rank === Math.max(...this.deck.candidates.map((c) => c.rank)));
	index = $derived(this.deck && this.current ? this.deck.candidates.findIndex((c) => c.rank === this.current!.rank) : -1);
	/** Spotify context of the current pick (generated picks play through the Daily pick playlist). */
	contextUri = $derived(this.current ? (this.current.kind === 'generated' ? (this.deck?.dailyPlaylistUri ?? null) : (this.current.playlist?.uri ?? null)) : null);
	/** Is the current pick what Spotify is playing right now? */
	isCurrentContext = $derived(
		!!this.current &&
			!!this.contextUri &&
			player.view.context?.uri === this.contextUri &&
			(this.current.kind !== 'generated' || this.deck?.state?.playedRank === this.current.rank)
	);

	set(deck: DailyDeck | null): void {
		this.deck = deck;
		// Keep following an active reseed job after a reload / navigation.
		const job = deck?.reseedJob ?? null;
		if (job && (job.status === 'queued' || job.status === 'running') && this.reseedJob.job?.id !== job.id) this.reseedJob.track(job);
	}

	async reload(): Promise<void> {
		if (!this.deck) return;
		this.deck = await apiGet<DailyDeck>(`/api/daily?date=${this.deck.date}`);
	}

	async rotate(): Promise<void> {
		const d = this.deck;
		const c = this.current;
		if (!d || !c || this.rotating) return;
		if (this.isLast) return this.reseed();
		this.rotating = true;
		const started = performance.now();
		try {
			const r = await apiPost<MoveResponse>('/api/daily/rotate', { date: d.date, from_rank: c.rank });
			await new Promise((res) => setTimeout(res, Math.max(0, MIN_SKELETON_MS - (performance.now() - started))));
			this.deck = r.deck;
			if (r.deck.current?.playlist) toasts.show('Rotated · the previous pick rests for a while');
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			this.rotating = false;
		}
	}

	async select(rank: number): Promise<void> {
		const d = this.deck;
		if (!d) return;
		try {
			this.deck = (await apiPost<MoveResponse>('/api/daily/select', { date: d.date, rank })).deck;
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}

	/** "Shuffle the deck" (R2): a hub job; without jobs the deck starts over. */
	async reseed(): Promise<void> {
		const d = this.deck;
		if (!d || this.reseeding) return;
		try {
			const r = await apiPost<{ mode: 'job'; job: JobRow } | { mode: 'wrap'; rank: number }>('/api/daily/reseed', { date: d.date });
			if (r.mode === 'wrap') {
				await this.reload();
				toasts.show('Back to the first pick. New picks on demand need hub jobs (Settings › Data health).');
				return;
			}
			this.#follow(r.job);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}

	#follow(job: JobRow | null): void {
		if (!job) return;
		this.reseedJob.track(job);
		if (job.status === 'failed') this.#failed(job);
	}

	#failed(job: JobRow): void {
		toasts.show(`Shuffle the deck failed: ${job.error ?? 'unknown error'}`, {
			kind: 'error',
			action: job.attempts < MAX_ATTEMPTS ? { label: 'Retry', run: () => void this.reseedJob.retry() } : undefined,
			ms: 8000
		});
	}

	async play(offset?: number): Promise<void> {
		const d = this.deck;
		const c = this.current;
		if (!d || !c) return;
		if (this.isCurrentContext && offset === undefined) {
			await player.togglePlay();
			return;
		}
		const ok = await player.playDaily(d.date, c.rank, c.title, offset);
		if (ok) this.#markPlayed(c.rank);
	}

	#markPlayed(rank: number): void {
		if (this.deck?.state) this.deck.state = { ...this.deck.state, playedRank: rank, playedAt: new Date().toISOString() };
		// The Daily pick playlist may have just been created: pick up its URI.
		if (!this.deck?.dailyPlaylistUri) void this.reload().catch(() => undefined);
	}
}

export const daily = new DailyStore();
