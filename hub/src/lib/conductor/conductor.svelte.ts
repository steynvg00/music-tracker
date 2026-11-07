/**
 * Mixed-session conductor, the stateful part (R5). It drives the existing Spotify player
 * (play `uris`, pause) and the page's in-app player (YouTube IFrame / SoundCloud widget), using
 * the pure rules in machine.ts, and logs every handoff (handoff_events) for the summary.
 *
 * Only one source plays at a time: Spotify is stopped (its run ended, or Rotor paused it)
 * before YouTube/SoundCloud starts, and the reverse (Spotify Developer Policy III.7: no overlap).
 */
import { apiPost } from '$lib/player/api-client';
import { player } from '$lib/stores/player.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import { SOURCE_LABEL } from '$lib/shared/elsewhere';
import { nextRun, observe, precheck, runAt, runs, slack, type Expect, type MixItem, type Mode, type Precheck, type Run } from './machine';

export type Phase = 'idle' | 'precheck' | 'spotify' | 'handoff' | 'inapp' | 'blocked' | 'diverged' | 'ended';

/** What the page's player stage offers the conductor. */
export interface InApp {
	cue(item: MixItem): void;
	play(item: MixItem): void;
	pause(): void;
}

const PRECUE_MS = 15_000;

export class Conductor {
	phase = $state<Phase>('idle');
	index = $state(0);
	mode = $state<Mode>('laptop');
	notice = $state<string | null>(null);
	check = $state<Precheck | null>(null);
	sessionId = $state<string | null>(null);
	items = $state<MixItem[]>([]);
	switching = $state<string | null>(null);

	mixId: string | null = null;
	inApp: InApp | null = null;
	rs = $state<Run[]>([]);
	run = $state<Run | null>(null);
	#expect: Expect | null = null;
	#positions: number[] = []; // mix position of each URI in the current Spotify run
	#handoff: { from: MixItem['source']; at: number; to: MixItem['source'] } | null = null;
	#cued: number | null = null;
	#timer: ReturnType<typeof setInterval> | undefined;

	get current(): MixItem | null {
		return this.items[this.index] ?? null;
	}
	get runs(): Run[] {
		return this.rs;
	}
	get nextLabel(): string | null {
		const n = nextRun(this.rs, this.run);
		return n ? (n.source === 'spotify' ? 'Spotify' : SOURCE_LABEL[n.source]) : null;
	}

	load(mixId: string, items: MixItem[], mode: Mode): void {
		this.mixId = mixId;
		this.items = items.map((i) => ({ ...i }));
		this.mode = mode;
		this.rs = runs(this.items);
		this.phase = 'idle';
	}

	/** Same-output-device precondition (F5). */
	precheck(): Precheck {
		const d = player.view.device;
		this.check = precheck(this.mode, d ? { id: d.id, name: d.name, type: d.type } : null, player.sdkDeviceId);
		return this.check;
	}

	/** Leave out every YouTube/SoundCloud item (the "Skip YouTube items" choice). */
	spotifyOnly(): void {
		this.items = this.items.map((i) => (i.source === 'spotify' ? i : { ...i, skip: true }));
		this.rs = runs(this.items);
	}

	async start(): Promise<void> {
		if (!this.mixId || !this.rs.length) return;
		const d = player.view.device;
		const r = await apiPost<{ id: string }>(`/api/mixes/${this.mixId}/sessions`, { mode: this.mode, deviceLabel: d?.name ?? null, spotifyDeviceId: d?.id ?? null });
		this.sessionId = r.id;
		this.#startTimer();
		await this.#beginRun(this.rs[0]!, this.rs[0]!.start, null);
	}

	/** Re-open from a relay push: continue at `position` with a tap (the tap is the user gesture). */
	attach(sessionId: string, position: number): void {
		this.sessionId = sessionId;
		this.index = position;
		this.run = runAt(this.rs, position);
		this.phase = 'blocked';
		this.#startTimer();
	}

	/** The tap card's button: start the in-app part inside a user gesture. */
	tapToContinue(): void {
		const it = this.current;
		if (!it || !this.inApp) return;
		this.#handoff ??= { from: 'spotify', at: performance.now(), to: it.source };
		this.phase = 'handoff';
		this.inApp.play(it);
	}

	resume(): void {
		if (this.phase !== 'diverged' || !this.run) return;
		this.notice = null;
		void this.#beginRun(this.run, this.index, null);
	}

	async end(): Promise<unknown> {
		clearInterval(this.#timer);
		this.inApp?.pause();
		const was = this.phase;
		this.phase = 'ended';
		if (!this.sessionId) return null;
		return apiPost(`/api/mix-sessions/${this.sessionId}/end`, { finalState: { phase: was, position: this.index } }).catch(() => null);
	}

	destroy(): void {
		clearInterval(this.#timer);
	}

	// ── events from the in-app player ──────────────────────────────────────────

	onInAppPlaying(): void {
		if (this.phase === 'handoff' || this.phase === 'blocked') {
			if (this.#handoff) {
				void this.#log({ from: this.#handoff.from, to: this.#handoff.to, outcome: 'ok', gapMs: Math.round(performance.now() - this.#handoff.at), position: this.index });
				this.#handoff = null;
			}
			this.phase = 'inapp';
			this.switching = null;
		}
	}

	onInAppBlocked(): void {
		this.phase = 'blocked';
		void this.#log({ from: this.#handoff?.from ?? null, to: this.current?.source ?? null, outcome: 'autoplay_blocked', position: this.index });
	}

	onInAppUnplayable(kind: 'not_embeddable' | 'preview_skipped'): void {
		const it = this.current;
		if (it) {
			it.skip = true;
			toasts.show(kind === 'not_embeddable' ? `Skipped “${it.title}” — the uploader doesn’t allow embedding` : `Skipped “${it.title}” — only a 30-second preview plays here`);
			void this.#log({ from: this.#handoff?.from ?? null, to: it.source, outcome: kind, position: this.index });
		}
		this.onInAppEnded(true);
	}

	onInAppEnded(skipped = false): void {
		if (this.phase !== 'inapp' && !skipped) return;
		const run = this.run;
		if (!run) return;
		for (let i = this.index + 1; i <= run.end; i++) {
			if (!this.items[i]?.skip) {
				this.index = i;
				void this.#progress();
				this.inApp?.play(this.items[i]!);
				return;
			}
		}
		const next = nextRun(this.rs, run);
		if (!next) return void this.end();
		const from = this.items[run.start]!.source;
		if (next.source === 'spotify') {
			this.inApp?.pause();
			void this.#beginRun(next, next.start, from);
		} else void this.#beginRun(next, next.start, from);
	}

	// ── internals ───────────────────────────────────────────────────────────────

	#startTimer(): void {
		clearInterval(this.#timer);
		this.#timer = setInterval(() => this.tick(), 500);
	}

	async #beginRun(run: Run, from: number, prevSource: MixItem['source'] | null): Promise<void> {
		this.run = run;
		this.index = from;
		this.#cued = null;
		void this.#progress();
		if (run.source !== 'spotify') {
			const it = this.items[from]!;
			this.switching = `Switching to ${SOURCE_LABEL[run.source]}…`;
			this.#handoff = prevSource ? { from: prevSource, at: performance.now(), to: run.source } : null;
			this.phase = 'handoff';
			this.inApp?.play(it);
			return;
		}
		const uris: string[] = [];
		this.#positions = [];
		for (let i = from; i <= run.end; i++) {
			const it = this.items[i]!;
			if (!it.skip && it.spotifyUri) {
				uris.push(it.spotifyUri);
				this.#positions.push(i);
			}
		}
		this.#expect = { uris, index: 0, itemStartedAt: Date.now(), duration: this.items[from]?.durationMs ?? 0, starting: true };
		this.#handoff = prevSource ? { from: prevSource, at: performance.now(), to: 'spotify' } : null;
		this.switching = prevSource ? 'Switching to Spotify…' : null;
		this.phase = 'spotify';
		await player.play({ type: 'play', body: { uris }, label: 'Mix' });
	}

	/**
	 * iPhone: once Spotify confirms the run is playing, ask the hub to push at its end. The time
	 * left = what Spotify reports for the current track + the catalogue length of the rest.
	 */
	#scheduleRelay(run: Run, at: number, currentRemainingMs: number): void {
		const next = nextRun(this.rs, run);
		if (!next || next.source === 'spotify' || !this.sessionId) return;
		const rest = this.items.slice(at + 1, run.end + 1).reduce((a, i) => a + (i.skip ? 0 : (i.durationMs ?? 180_000)), 0);
		const ms = Math.max(0, currentRemainingMs) + rest;
		void apiPost(`/api/mix-sessions/${this.sessionId}/relay`, { inMs: ms, position: next.start, label: SOURCE_LABEL[next.source] }).catch(() => undefined);
	}

	/** Called every 500 ms and whenever the player view changes. */
	tick(): void {
		if (this.phase !== 'spotify' || !this.#expect) return;
		const v = player.view;
		const now = Date.now();
		const snap = {
			isPlaying: v.isPlaying,
			itemUri: v.item?.uri ?? null,
			progressMs: v.progressMs,
			durationMs: v.item?.durationMs ?? 0,
			contextUri: v.context?.uri ?? null
		};
		const o = observe(this.#expect, snap, now);
		const e = this.#expect;
		switch (o.kind) {
			case 'playing': {
				if (e.starting) {
					e.starting = false;
					this.switching = null;
					if (this.mode === 'relay' && this.run) this.#scheduleRelay(this.run, this.#positions[o.index] ?? this.index, (snap.durationMs || e.duration) - player.position);
					if (this.#handoff) {
						void this.#log({ from: this.#handoff.from, to: 'spotify', outcome: 'ok', gapMs: Math.round(performance.now() - this.#handoff.at), position: this.index });
						this.#handoff = null;
					}
				}
				if (o.index !== e.index) e.index = o.index;
				e.duration = snap.durationMs || e.duration;
				e.itemStartedAt = now - player.position;
				const pos = this.#positions[o.index] ?? this.index;
				if (pos !== this.index) {
					this.index = pos;
					void this.#progress();
				}
				// Pre-cue the in-app item while Spotify's last track plays (§6.2), so the handoff is quick.
				const next = nextRun(this.rs, this.run);
				if (next && next.source !== 'spotify' && o.index === e.uris.length - 1 && e.duration - player.position < PRECUE_MS && this.#cued !== next.start) {
					this.#cued = next.start;
					this.inApp?.cue(this.items[next.start]!);
				}
				break;
			}
			case 'run_end':
				this.#expect = null;
				void this.#afterSpotify();
				break;
			case 'autoplay':
				// F3: device Autoplay kept Spotify going after our run. Stop it at once, tell the user.
				this.#expect = null;
				void player.pause();
				this.notice = 'Spotify autoplay was on for this device. Turn it off in Spotify › Settings › Playback for smoother mixes.';
				void this.#log({ from: 'spotify', to: null, outcome: 'spotify_autoplay', position: this.index });
				void this.#afterSpotify();
				break;
			case 'diverged':
				// F6: never fight the user.
				this.#expect = null;
				this.phase = 'diverged';
				this.notice = 'Mix paused — you’re playing something else in Spotify.';
				void this.#log({ from: 'spotify', to: null, outcome: 'diverged', position: this.index, detail: { why: o.why } });
				break;
			default:
				break;
		}
	}

	async #afterSpotify(): Promise<void> {
		const run = this.run;
		const next = nextRun(this.rs, run);
		if (!next) {
			await this.end();
			return;
		}
		await this.#beginRun(next, next.start, 'spotify');
	}

	async #progress(): Promise<void> {
		if (this.sessionId) await apiPost(`/api/mix-sessions/${this.sessionId}/progress`, { position: this.index }).catch(() => undefined);
	}

	async #log(e: { from: string | null; to: string | null; outcome: string; gapMs?: number; position?: number; detail?: unknown }): Promise<void> {
		if (this.sessionId) await apiPost(`/api/mix-sessions/${this.sessionId}/events`, e).catch(() => undefined);
	}
}

/** For the session summary line. */
export function fmtGap(ms: number | null): string {
	return ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
}

export { slack };
