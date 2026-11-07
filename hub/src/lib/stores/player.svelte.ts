/**
 * Now-playing store (04-architecture.md §6.1).
 *
 * - ConnectAdapter: adaptive polling of /api/player/state (polling.ts rules), zero
 *   requests while the tab is hidden.
 * - SdkAdapter: when "This laptop" (Web Playback SDK) is the device, SDK events drive
 *   the state and polling stops.
 * - Optimistic overlay: commands show immediately, are confirmed by polls at +300 and
 *   +1200 ms and roll back after two mismatches.
 * - Serialised command queue: Spotify doesn't guarantee execution order.
 * - Tabs coordinate over BroadcastChannel('rotor-player'): whoever polls broadcasts,
 *   the others adopt the state and stand down.
 * - Pending intent: Play without a device opens the picker; with no device at all the
 *   wake flow (Open Spotify) runs the intent server-side as soon as a device appears.
 */
import { browser } from '$app/environment';
import type {
	ContextInfo,
	PlayBody,
	PlayerDevice,
	PlayerSnapshot,
	PlayerStateResponse,
	TrackStats
} from '$lib/shared/player-types';
import { apiGet, apiPost, ApiFailure, describeFailure } from '$lib/player/api-client';
import { CONFIRM_DELAYS_MS, interpolate, nextPollDelay, nextRepeat, overlays, reconcile, type Overlay } from '$lib/player/polling';
import { isPhoneLike, loadSdk, SDK_DEVICE_NAME, sdkStateToSnapshot, sdkWanted, type SpotifyPlayer, type WebPlaybackState } from '$lib/player/spotify-sdk';
import { toasts } from './toasts.svelte';
import { ui } from './ui.svelte';

export type PendingIntent =
	| { type: 'play'; body: PlayBody; label: string }
	| { type: 'daily'; date: string; rank: number; offset?: number; label: string }
	/** R6: "Play your top 100" — the server rewrites "Wrapped <year> · Auto 🤖📸" (write guard), then plays it. */
	| { type: 'wrapped'; year: number; label: string };

type WakeState = 'idle' | 'waiting' | 'timeout';

const INACTIVE: PlayerSnapshot = {
	active: false,
	device: null,
	item: null,
	context: null,
	isPlaying: false,
	progressMs: 0,
	shuffle: false,
	repeat: 'off',
	disallows: {}
};
const LAST_DEVICE_KEY = 'rotor.lastDevice';
const QUOTA_HOLD_MS = 10 * 60 * 1000;
const PEER_SLACK_MS = 1500;
const TICK_MS = 250;
const WAKE_RECHECK_MS = 15_000;

function lastDevice(): string | null {
	try {
		return localStorage.getItem(LAST_DEVICE_KEY);
	} catch {
		return null;
	}
}
function rememberDevice(id: string | null | undefined): void {
	if (!id) return;
	try {
		localStorage.setItem(LAST_DEVICE_KEY, id);
	} catch {
		/* private mode */
	}
}

interface PeerMessage {
	type: 'state';
	response: PlayerStateResponse;
	ageMs: number;
	nextDelayMs: number | null;
}

export class PlayerStore {
	snapshot = $state<PlayerSnapshot>(INACTIVE);
	contextInfo = $state<ContextInfo | null>(null);
	trackStats = $state<TrackStats | null>(null);
	fetchedAt = $state(0);
	now = $state(0);
	loaded = $state(false);
	reauth = $state(false);
	quotaLimited = $state(false);
	overlay = $state<Overlay | null>(null);
	devices = $state<PlayerDevice[]>([]);
	devicesLoading = $state(false);
	pending = $state<PendingIntent | null>(null);
	wake = $state<WakeState>('idle');
	transferring = $state<string | null>(null);
	sdkEnabled = $state(false);
	sdkReady = $state(false);
	sdkDeviceId = $state<string | null>(null);
	sdkError = $state<string | null>(null);
	visible = $state(true);

	view = $derived(this.overlay ? this.overlay.apply(this.snapshot) : this.snapshot);
	position = $derived(interpolate(this.view.progressMs, this.fetchedAt, this.now, this.view.isPlaying, this.view.item?.durationMs ?? 0));
	sdkDriving = $derived(!!this.sdkDeviceId && this.snapshot.device?.id === this.sdkDeviceId);
	deviceName = $derived(this.sdkDriving ? 'This laptop' : (this.view.device?.name ?? null));

	#started = false;
	#pollTimer: ReturnType<typeof setTimeout> | undefined;
	#confirmTimers: ReturnType<typeof setTimeout>[] = [];
	#inFlight = false;
	#rateLimitedUntil = 0;
	#quotaUntil = 0;
	#raf = 0;
	#lastTick = 0;
	#queue: Promise<unknown> = Promise.resolve();
	#channel: BroadcastChannel | null = null;
	#sdk: SpotifyPlayer | null = null;
	#sdkInit: Promise<string | null> | null = null;
	#wakeStartedAt = 0;

	// ── lifecycle ──────────────────────────────────────────────────────────────

	start(): void {
		if (!browser || this.#started) return;
		this.#started = true;
		this.visible = document.visibilityState === 'visible';
		this.now = performance.now();
		document.addEventListener('visibilitychange', this.#onVisibility);
		try {
			this.#channel = new BroadcastChannel('rotor-player');
			this.#channel.onmessage = (e: MessageEvent<PeerMessage>) => this.#onPeer(e.data);
		} catch {
			this.#channel = null;
		}
		void this.poll();
		this.sdkEnabled = sdkWanted();
		if (this.sdkEnabled) {
			const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
			(idle ?? ((cb: () => void) => setTimeout(cb, 1500)))(() => void this.initSdk());
		}
	}

	stop(): void {
		if (!browser) return;
		this.#clearTimers();
		document.removeEventListener('visibilitychange', this.#onVisibility);
		this.#channel?.close();
		this.#sdk?.disconnect();
		this.#started = false;
	}

	#onVisibility = () => {
		this.visible = document.visibilityState === 'visible';
		if (!this.visible) {
			this.#clearTimers();
			return;
		}
		void this.poll();
		if (this.wake === 'waiting' && Date.now() - this.#wakeStartedAt > WAKE_RECHECK_MS) {
			// The wake request may have finished while iOS had the PWA suspended.
			setTimeout(() => {
				if (this.wake === 'waiting') this.wake = this.snapshot.isPlaying ? 'idle' : 'timeout';
				if (this.wake === 'idle' && this.snapshot.isPlaying) this.#wakeDone(this.snapshot.device?.name ?? null);
			}, 1500);
		}
	};

	#clearTimers(): void {
		clearTimeout(this.#pollTimer);
		this.#pollTimer = undefined;
		for (const t of this.#confirmTimers) clearTimeout(t);
		this.#confirmTimers = [];
		if (this.#raf) cancelAnimationFrame(this.#raf);
		this.#raf = 0;
	}

	// ── polling ────────────────────────────────────────────────────────────────

	async poll(): Promise<void> {
		if (!browser) return;
		clearTimeout(this.#pollTimer);
		if (!this.visible || this.#inFlight) return;
		this.#inFlight = true;
		try {
			const r = await apiGet<PlayerStateResponse>('/api/player/state');
			this.reauth = false;
			this.#apply(r, performance.now());
			this.#broadcast(r);
		} catch (e) {
			if (e instanceof ApiFailure) {
				if (e.status === 401) this.reauth = true;
				if (e.status === 429) {
					this.#rateLimitedUntil = performance.now() + (e.retryAfterS ?? 5) * 1000;
					if (e.body.reason === 'QUOTA_EXCEEDED') this.#quotaUntil = performance.now() + QUOTA_HOLD_MS;
				}
			}
		} finally {
			this.#inFlight = false;
			this.loaded = true;
			this.quotaLimited = this.#quotaUntil > performance.now();
			this.#schedule();
		}
	}

	#nextDelay(): number | null {
		const v = this.view;
		const remaining = v.item && v.isPlaying ? v.item.durationMs - this.position : null;
		const now = performance.now();
		return nextPollDelay({
			visible: this.visible,
			sdkDriving: this.sdkDriving,
			isPlaying: v.isPlaying,
			remainingMs: remaining,
			now,
			rateLimitedUntil: this.#rateLimitedUntil,
			quotaLimited: this.#quotaUntil > now
		});
	}

	#schedule(extraMs = 0): void {
		clearTimeout(this.#pollTimer);
		const d = this.#nextDelay();
		if (d !== null) this.#pollTimer = setTimeout(() => void this.poll(), d + extraMs);
	}

	#confirm(): void {
		if (this.sdkDriving) return;
		for (const ms of CONFIRM_DELAYS_MS) this.#confirmTimers.push(setTimeout(() => void this.poll(), ms));
	}

	#apply(r: PlayerStateResponse, at: number): void {
		const prevUri = this.snapshot.item?.uri ?? null;
		this.overlay = reconcile(this.overlay, r.snapshot, at).overlay;
		this.snapshot = r.snapshot;
		this.contextInfo = r.contextInfo;
		this.trackStats = r.trackStats;
		this.fetchedAt = at;
		this.now = at;
		if (r.snapshot.device?.id && r.snapshot.device.id !== this.sdkDeviceId) rememberDevice(r.snapshot.device.id);
		this.#announce(prevUri);
		this.#ensureTick();
	}

	#announce(prevUri: string | null): void {
		const it = this.snapshot.item;
		if (!it || it.uri === prevUri) return;
		const who = it.artists.map((a) => a.name).join(', ');
		ui.announce(`Now playing ${it.name}${who ? ` by ${who}` : ''}${this.deviceName ? ` on ${this.deviceName}` : ''}`);
	}

	#ensureTick(): void {
		if (!browser || this.#raf || !this.visible || !this.view.isPlaying) return;
		const tick = (t: number) => {
			if (t - this.#lastTick >= TICK_MS) {
				this.#lastTick = t;
				this.now = performance.now();
			}
			this.#raf = this.visible && this.view.isPlaying ? requestAnimationFrame(tick) : 0;
		};
		this.#raf = requestAnimationFrame(tick);
	}

	#broadcast(r: PlayerStateResponse): void {
		this.#channel?.postMessage({ type: 'state', response: r, ageMs: 0, nextDelayMs: this.#nextDelay() } satisfies PeerMessage);
	}

	#onPeer(m: PeerMessage): void {
		if (m?.type !== 'state') return;
		this.#apply(m.response, performance.now() - m.ageMs);
		// Another tab just polled: stand down until shortly after its next poll.
		if (m.nextDelayMs !== null && this.visible) this.#schedule(PEER_SLACK_MS + Math.random() * 500);
	}

	// ── commands ───────────────────────────────────────────────────────────────

	#enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	#fail(e: unknown): void {
		this.overlay = null;
		ui.shake();
		if (e instanceof ApiFailure && e.status === 401) this.reauth = true;
		toasts.error(describeFailure(e));
	}

	async #command(cmd: string, body: Record<string, unknown>, overlay?: Overlay, sdk?: (p: SpotifyPlayer) => Promise<void>): Promise<void> {
		return this.#enqueue(async () => {
			if (overlay) this.overlay = overlay;
			try {
				if (this.sdkDriving && this.#sdk && sdk) {
					await sdk(this.#sdk);
				} else {
					await apiPost(`/api/player/${cmd}`, { device_id: this.snapshot.device?.id ?? undefined, ...body });
					this.#confirm();
				}
			} catch (e) {
				if (e instanceof ApiFailure && e.body.error === 'no_active_device') {
					this.overlay = null;
					await this.#openPicker({ type: 'play', body: {}, label: 'Resume' });
					return;
				}
				this.#fail(e);
			}
		});
	}

	togglePlay(): Promise<void> {
		return this.view.isPlaying ? this.pause() : this.resume();
	}

	pause(): Promise<void> {
		return this.#command('pause', {}, overlays.playPause(false, performance.now()), (p) => p.pause());
	}

	async resume(): Promise<void> {
		if (!this.snapshot.active) {
			await this.play({ type: 'play', body: {}, label: 'Resume' });
			return;
		}
		return this.#command('play', {}, overlays.playPause(true, performance.now()), (p) => p.resume());
	}

	next(): Promise<void> {
		return this.#command('next', {}, overlays.skip(this.snapshot.item?.uri ?? null, performance.now()), (p) => p.nextTrack());
	}

	previous(): Promise<void> {
		if (this.position > 3000) return this.seek(0);
		return this.#command('previous', {}, overlays.skip(this.snapshot.item?.uri ?? null, performance.now()), (p) => p.previousTrack());
	}

	seek(positionMs: number): Promise<void> {
		const ms = Math.max(0, Math.round(positionMs));
		return this.#command('seek', { position_ms: ms }, overlays.seek(ms, performance.now()), (p) => p.seek(ms));
	}

	setVolume(pct: number): Promise<void> {
		const v = Math.max(0, Math.min(100, Math.round(pct)));
		return this.#command('volume', { volume_percent: v }, overlays.volume(v, performance.now()), (p) => p.setVolume(v / 100));
	}

	toggleShuffle(): Promise<void> {
		const s = !this.view.shuffle;
		return this.#command('shuffle', { state: s }, overlays.shuffle(s, performance.now()));
	}

	cycleRepeat(): Promise<void> {
		const r = nextRepeat(this.view.repeat);
		return this.#command('repeat', { state: r }, overlays.repeat(r, performance.now()));
	}

	// ── play intents + device picker + wake ──────────────────────────────────────

	/** Play something. Needs a device: active one, else the picker / wake flow. */
	async play(intent: PendingIntent): Promise<boolean> {
		const active = this.snapshot.active ? this.snapshot.device?.id : null;
		if (active) return this.#enqueue(() => this.#execute(intent, active));
		await this.#openPicker(intent);
		return false;
	}

	playContext(uri: string, label: string, offset?: PlayBody['offset']): Promise<boolean> {
		return this.play({ type: 'play', body: { context_uri: uri, ...(offset ? { offset } : {}) }, label });
	}

	playDaily(date: string, rank: number, label: string, offset?: number): Promise<boolean> {
		return this.play({ type: 'daily', date, rank, label, ...(offset ? { offset } : {}) });
	}

	playWrapped(year: number, label: string): Promise<boolean> {
		return this.play({ type: 'wrapped', year, label });
	}

	async #execute(intent: PendingIntent, deviceId: string): Promise<boolean> {
		const now = performance.now();
		this.overlay = overlays.playPause(true, now);
		try {
			let contextUri: string | null = intent.type === 'play' ? (intent.body.context_uri ?? null) : null;
			if (intent.type === 'play') {
				await apiPost('/api/player/play', { ...intent.body, device_id: deviceId });
			} else if (intent.type === 'wrapped') {
				const r = await apiPost<{ contextUri: string }>(`/api/wrapped/${intent.year}/play`, { device_id: deviceId });
				contextUri = r.contextUri;
			} else {
				const r = await apiPost<{ contextUri: string }>('/api/daily/play', {
					date: intent.date,
					rank: intent.rank,
					offset: intent.offset ?? 0,
					device_id: deviceId
				});
				contextUri = r.contextUri;
			}
			if (contextUri) {
				const uri = contextUri;
				this.overlay = {
					kind: 'play-context',
					issuedAt: now,
					mismatches: 0,
					apply: (s) => ({ ...s, isPlaying: true, context: { uri, type: 'playlist' }, progressMs: s.context?.uri === uri ? s.progressMs : 0 }),
					confirmed: (s) => s.isPlaying && s.context?.uri === uri
				};
			}
			this.pending = null;
			rememberDevice(deviceId === this.sdkDeviceId ? null : deviceId);
			this.#confirm();
			return true;
		} catch (e) {
			this.overlay = null;
			if (e instanceof ApiFailure && (e.body.error === 'no_active_device' || e.status === 404)) {
				await this.#openPicker(intent);
				return false;
			}
			this.#fail(e);
			return false;
		}
	}

	async #openPicker(intent: PendingIntent | null): Promise<void> {
		this.pending = intent;
		this.wake = 'idle';
		ui.open('devices');
		await this.refreshDevices();
	}

	/** Device button / device strip: no intent, picking transfers playback. */
	openDevices(): Promise<void> {
		return this.#openPicker(null);
	}

	async refreshDevices(): Promise<void> {
		this.devicesLoading = true;
		try {
			const r = await apiGet<{ devices: PlayerDevice[] }>('/api/player/devices');
			this.devices = r.devices;
		} catch (e) {
			if (e instanceof ApiFailure && e.status === 401) this.reauth = true;
		} finally {
			this.devicesLoading = false;
		}
	}

	/** Devices for the picker, "This laptop" (SDK) excluded: it has its own row. */
	get connectDevices(): PlayerDevice[] {
		return this.devices.filter((d) => d.id !== this.sdkDeviceId);
	}

	get lastDeviceId(): string | null {
		return lastDevice();
	}

	async pickDevice(deviceId: string, name: string): Promise<void> {
		this.transferring = deviceId;
		try {
			if (this.pending) {
				const ok = await this.#enqueue(() => this.#execute(this.pending!, deviceId));
				if (!ok) return;
			} else {
				await apiPost('/api/player/transfer', { device_id: deviceId, play: true });
				rememberDevice(deviceId === this.sdkDeviceId ? null : deviceId);
				this.#confirm();
			}
			ui.close();
			toasts.show(`Playing on ${name}`);
		} catch (e) {
			this.#fail(e);
		} finally {
			this.transferring = null;
		}
	}

	/** Must run synchronously inside the click handler (autoplay policies), before any await. */
	activateSdkElement(): void {
		void this.#sdk?.activateElement().catch(() => undefined);
	}

	async pickThisLaptop(): Promise<void> {
		this.transferring = 'sdk';
		const id = this.sdkDeviceId ?? (await this.initSdk());
		this.transferring = null;
		if (!id) {
			toasts.error(this.sdkError ? `This laptop can’t play: ${this.sdkError}` : 'This laptop can’t play right now.');
			return;
		}
		await this.pickDevice(id, 'This laptop');
	}

	/** "Open Spotify on this phone": fire the server-side wake, then the spotify: link opens the app. */
	startWake(): void {
		const intent = this.pending ?? { type: 'play' as const, body: {}, label: 'Resume' };
		this.wake = 'waiting';
		this.#wakeStartedAt = Date.now();
		const { label: _label, ...wire } = intent;
		apiPost<{ status: 'played'; device: PlayerDevice } | { status: 'timeout' }>(
			'/api/player/wake',
			{ intent: wire, prefer: isPhoneLike() ? 'Smartphone' : null, known_ids: this.devices.map((d) => d.id).filter(Boolean) },
			{ keepalive: true }
		)
			.then((r) => {
				if (r.status === 'played') this.#wakeDone(r.device.name);
				else this.wake = 'timeout';
			})
			.catch(() => {
				if (this.wake === 'waiting') this.wake = 'timeout';
			});
	}

	#wakeDone(name: string | null): void {
		this.wake = 'idle';
		this.pending = null;
		ui.close();
		if (name) toasts.show(`Playing on ${name}`);
		void this.poll();
	}

	retryDevices(): Promise<void> {
		this.wake = 'idle';
		return this.refreshDevices();
	}

	// ── Web Playback SDK ("This laptop") ─────────────────────────────────────────

	initSdk(): Promise<string | null> {
		if (!browser) return Promise.resolve(null);
		if (this.#sdkInit) return this.#sdkInit;
		this.sdkEnabled = true;
		this.#sdkInit = (async () => {
			const S = await loadSdk();
			const player = new S.Player({
				name: SDK_DEVICE_NAME,
				volume: 0.7,
				getOAuthToken: (cb) => {
					apiGet<{ accessToken: string }>('/api/spotify/token')
						.then((r) => cb(r.accessToken))
						.catch(() => (this.reauth = true));
				}
			});
			this.#sdk = player;
			const ready = new Promise<string>((resolve, reject) => {
				player.addListener('ready', ({ device_id }) => {
					this.sdkDeviceId = device_id;
					this.sdkReady = true;
					this.sdkError = null;
					resolve(device_id);
				});
				player.addListener('not_ready', () => (this.sdkReady = false));
				player.addListener('player_state_changed', (s) => this.#onSdkState(s));
				for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'] as const) {
					player.addListener(ev, ({ message }) => {
						this.sdkError = message;
						reject(new Error(message));
					});
				}
				player.addListener('autoplay_failed', () => toasts.show('This browser blocked autoplay. Press play once.'));
				setTimeout(() => reject(new Error('the player did not start in time')), 15_000);
			});
			if (!(await player.connect())) throw new Error('could not connect');
			return ready;
		})().catch((e: unknown) => {
			this.#sdkInit = null;
			this.sdkError = e instanceof Error ? e.message : String(e);
			return null;
		});
		return this.#sdkInit;
	}

	#onSdkState(s: WebPlaybackState | null): void {
		if (!this.sdkDeviceId) return;
		if (!s) {
			// Playback moved to another device: back to polling.
			if (this.sdkDriving) void this.poll();
			return;
		}
		const prevUri = this.snapshot.item?.uri ?? null;
		const snap = sdkStateToSnapshot(s, this.sdkDeviceId, this.snapshot.device?.volumePercent ?? 70);
		const at = performance.now();
		this.overlay = reconcile(this.overlay, snap, at).overlay;
		this.snapshot = snap;
		this.fetchedAt = at;
		this.now = at;
		this.loaded = true;
		this.#ensureTick();
		if (snap.item?.uri !== prevUri) {
			this.#announce(prevUri);
			this.#mediaSession();
			// One enrichment request per track ("Playing from" + your history); no polling.
			void this.poll();
		}
		clearTimeout(this.#pollTimer);
	}

	#mediaSession(): void {
		if (!('mediaSession' in navigator) || !this.#sdk) return;
		const it = this.snapshot.item;
		const ms = navigator.mediaSession;
		if (it) {
			ms.metadata = new MediaMetadata({
				title: it.name,
				artist: it.artists.map((a) => a.name).join(', '),
				album: it.albumName ?? '',
				artwork: it.imageUrlLarge ? [{ src: it.imageUrlLarge, sizes: '640x640' }] : []
			});
		}
		const p = this.#sdk;
		const set = (a: MediaSessionAction, h: MediaSessionActionHandler) => {
			try {
				ms.setActionHandler(a, h);
			} catch {
				/* unsupported action */
			}
		};
		set('play', () => void p.resume());
		set('pause', () => void p.pause());
		set('nexttrack', () => void p.nextTrack());
		set('previoustrack', () => void p.previousTrack());
		set('seekto', (d) => d.seekTime !== undefined && void p.seek(d.seekTime * 1000));
	}
}

export const player = new PlayerStore();
