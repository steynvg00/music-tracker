/** Today's deck, shared by Home's hero, the daily-pick detail and the sidebar. */
import { browser } from '$app/environment';
import type { DailyDeck } from '$lib/shared/daily-types';
import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
import { player } from './player.svelte';
import { toasts } from './toasts.svelte';

const MIN_SKELETON_MS = 300;
const RESEED_POLL_MS = 5000;
const RESEED_MAX_MS = 3 * 60 * 1000;

type MoveResponse = { result: { ok: boolean; reason?: string }; deck: DailyDeck };

class DailyStore {
	deck = $state<DailyDeck | null>(null);
	rotating = $state(false);
	reseeding = $state(false);

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
		if (deck?.state?.reseedRequestedAt && !this.reseeding && Date.now() - Date.parse(deck.state.reseedRequestedAt) < RESEED_MAX_MS) {
			void this.#waitForReseed(deck.candidates.length);
		}
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

	/** "Shuffle the deck". */
	async reseed(): Promise<void> {
		const d = this.deck;
		if (!d || this.reseeding) return;
		try {
			const r = await apiPost<{ mode: 'dispatched' | 'pending' | 'wrap' }>('/api/daily/reseed', { date: d.date });
			if (r.mode === 'wrap') {
				await this.reload();
				toasts.show('Back to the first pick. New picks on demand need the GitHub dispatch token (Settings › Data health).');
				return;
			}
			void this.#waitForReseed(d.candidates.length);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}

	async #waitForReseed(before: number): Promise<void> {
		if (!browser || this.reseeding) return;
		this.reseeding = true;
		const until = Date.now() + RESEED_MAX_MS;
		try {
			while (Date.now() < until) {
				await new Promise((res) => setTimeout(res, RESEED_POLL_MS));
				if (document.visibilityState !== 'visible') continue;
				const deck = await apiGet<DailyDeck>(`/api/daily?date=${this.deck!.date}`).catch(() => null);
				if (deck && deck.candidates.length > before) {
					this.deck = deck;
					toasts.show(`${deck.candidates.length - before} fresh picks are ready`);
					return;
				}
			}
			toasts.error('New picks are taking longer than usual. Check the daily-pick-reseed workflow.');
		} finally {
			this.reseeding = false;
		}
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
