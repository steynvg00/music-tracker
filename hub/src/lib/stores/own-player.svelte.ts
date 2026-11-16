/**
 * Rotor's own audio player (v0.94) for uploaded own tracks and sets. One <audio> element, short-lived
 * signed URLs (refreshed automatically when one expires mid-play), Media Session for lock-screen
 * controls. Starting it pauses Spotify first. It is NOT a mixed queue: it only ever plays your own
 * uploads (a track, a Rotor list, or a set), never Spotify items (R5 #90 stays separate).
 *
 * Plays of own tracks (≥ 30 s or half the track) go to own_plays with source 'rotor'.
 */
import { browser } from '$app/environment';
import { apiGet, apiPost } from '$lib/player/api-client';
import { player } from '$lib/stores/player.svelte';
import type { PlaybackUrl } from '$lib/shared/media';
import type { OwnTrack } from '$lib/shared/own';
import { artistLine, displayTitle } from '$lib/shared/own';
import type { DjSet } from '$lib/shared/sets';

export interface OwnItem {
	kind: 'track' | 'set';
	id: string;
	mediaId: string;
	title: string;
	artist: string;
	cover: string | null;
	durationMs: number;
}

export const trackItem = (t: OwnTrack): OwnItem | null =>
	t.audio ? { kind: 'track', id: t.id, mediaId: t.audio.id, title: displayTitle(t), artist: artistLine(t.artists.primary), cover: t.cover, durationMs: t.durationMs } : null;
export const setItem = (s: DjSet): OwnItem | null =>
	s.audio ? { kind: 'set', id: s.id, mediaId: s.audio.id, title: s.title, artist: artistLine(s.artists), cover: s.cover, durationMs: s.durationMs } : null;

const MIN_PLAY_MS = 30_000;

class OwnPlayer {
	current = $state<OwnItem | null>(null);
	queue = $state<OwnItem[]>([]);
	index = $state(0);
	playing = $state(false);
	positionMs = $state(0);
	durationMs = $state(0);
	error = $state<string | null>(null);
	/** How many times an expired URL was replaced (shown for the E2E expiry check). */
	refreshes = $state(0);
	expiresAt = $state<string | null>(null);
	#audio: HTMLAudioElement | null = null;
	#listened = 0;
	#lastTick = 0;
	#retrying = false;
	/** What you asked for (a network error pauses the element; this survives it). */
	#wantPlay = false;

	#el(): HTMLAudioElement {
		if (this.#audio) return this.#audio;
		const a = new Audio();
		a.preload = 'auto';
		a.setAttribute('playsinline', '');
		a.dataset.testid = 'own-audio';
		a.style.display = 'none';
		document.body.appendChild(a);
		a.addEventListener('playing', () => {
			this.playing = true;
			this.error = null;
			this.#lastTick = a.currentTime;
			this.#session();
		});
		a.addEventListener('pause', () => {
			this.playing = false;
			this.#session();
		});
		a.addEventListener('timeupdate', () => {
			const t = a.currentTime;
			const d = t - this.#lastTick;
			if (this.playing && d > 0 && d < 2) this.#listened += d * 1000;
			this.#lastTick = t;
			this.positionMs = Math.round(t * 1000);
			if ('mediaSession' in navigator && Number.isFinite(a.duration) && a.duration > 0) {
				try {
					navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(t, a.duration), playbackRate: a.playbackRate });
				} catch {
					/* old Safari */
				}
			}
		});
		a.addEventListener('loadedmetadata', () => {
			if (Number.isFinite(a.duration) && a.duration > 0) this.durationMs = Math.round(a.duration * 1000);
		});
		a.addEventListener('ended', () => {
			void this.#flushPlay();
			if (this.index < this.queue.length - 1) void this.#go(this.index + 1, 0);
			else {
				this.playing = false;
				this.#wantPlay = false;
			}
		});
		// A signed URL that expired (or a dropped connection): fetch a fresh one and continue where we were.
		a.addEventListener('error', () => void this.#recover());
		this.#audio = a;
		return a;
	}

	async #url(mediaId: string): Promise<string> {
		const r = await apiGet<PlaybackUrl>(`/api/media/${mediaId}/play`);
		this.expiresAt = r.expiresAt;
		return r.url;
	}

	async #recover(): Promise<void> {
		const it = this.current;
		const a = this.#audio;
		if (!it || !a || this.#retrying) return;
		this.#retrying = true;
		const at = this.positionMs;
		const wasPlaying = this.#wantPlay || this.playing || !a.paused;
		try {
			for (let i = 0; i < 3; i++) {
				try {
					a.src = await this.#url(it.mediaId);
					this.refreshes++;
					await new Promise<void>((ok, fail) => {
						const done = () => (a.removeEventListener('loadedmetadata', done), a.removeEventListener('error', bad), ok());
						const bad = () => (a.removeEventListener('loadedmetadata', done), a.removeEventListener('error', bad), fail(new Error('load')));
						a.addEventListener('loadedmetadata', done);
						a.addEventListener('error', bad);
					});
					a.currentTime = at / 1000;
					if (wasPlaying) await a.play();
					return;
				} catch {
					await new Promise((r) => setTimeout(r, 500 * (i + 1)));
				}
			}
			this.error = 'This file couldn’t be played. Check your connection and try again.';
			this.playing = false;
		} finally {
			this.#retrying = false;
		}
	}

	async #flushPlay(): Promise<void> {
		const it = this.current;
		const ms = Math.round(this.#listened);
		this.#listened = 0;
		if (!it || it.kind !== 'track') return;
		if (ms >= Math.min(MIN_PLAY_MS, it.durationMs / 2)) await apiPost(`/api/own/${it.id}/plays`, { msPlayed: ms }, { keepalive: true }).catch(() => undefined);
	}

	async #pauseSpotify(): Promise<void> {
		if (player.view.isPlaying) await player.pause().catch(() => undefined);
	}

	async #go(i: number, atMs: number): Promise<void> {
		const it = this.queue[i];
		if (!it) return;
		await this.#flushPlay();
		this.index = i;
		this.current = it;
		this.positionMs = atMs;
		this.durationMs = it.durationMs;
		this.error = null;
		this.#wantPlay = true;
		const a = this.#el();
		try {
			a.src = await this.#url(it.mediaId);
			if (atMs) {
				await new Promise<void>((ok) => {
					const f = () => (a.removeEventListener('loadedmetadata', f), ok());
					a.addEventListener('loadedmetadata', f);
					setTimeout(ok, 4000);
				});
				a.currentTime = atMs / 1000;
			}
			await a.play();
		} catch (e) {
			this.playing = false;
			this.error = e instanceof Error && e.name === 'NotAllowedError' ? 'Tap play to start (the browser blocked autoplay)' : 'This file couldn’t be played right now.';
		}
		this.#session();
	}

	/** Play one item or a list (Rotor list / set). Pauses Spotify first. */
	async play(items: OwnItem[], start = 0, atMs = 0): Promise<void> {
		if (!browser || !items.length) return;
		this.#el(); // created inside the tap (iOS needs the user gesture)
		await this.#pauseSpotify();
		this.queue = items;
		await this.#go(start, atMs);
	}

	async toggle(): Promise<void> {
		const a = this.#audio;
		if (!a || !this.current) return;
		if (a.paused) {
			this.#wantPlay = true;
			await this.#pauseSpotify();
			await a.play().catch(() => void this.#recover());
		} else {
			this.#wantPlay = false;
			a.pause();
		}
	}
	pause(): void {
		this.#wantPlay = false;
		this.#audio?.pause();
	}
	seek(ms: number): void {
		const a = this.#audio;
		if (!a || !this.current) return;
		this.#lastTick = ms / 1000;
		a.currentTime = Math.max(0, ms) / 1000;
		this.positionMs = Math.round(ms);
		if (a.paused) void this.toggle();
	}
	skip(deltaMs: number): void {
		this.seek(Math.max(0, Math.min(this.durationMs || Infinity, this.positionMs + deltaMs)));
	}
	next(): void {
		if (this.index < this.queue.length - 1) void this.#go(this.index + 1, 0);
	}
	previous(): void {
		if (this.positionMs > 3000 || this.index === 0) this.seek(0);
		else void this.#go(this.index - 1, 0);
	}
	async stop(): Promise<void> {
		this.#wantPlay = false;
		await this.#flushPlay();
		const a = this.#audio;
		if (a) {
			a.pause();
			a.removeAttribute('src');
			a.load();
		}
		this.current = null;
		this.queue = [];
		this.playing = false;
		if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
	}

	#session(): void {
		if (!browser || !('mediaSession' in navigator)) return;
		const it = this.current;
		const ms = navigator.mediaSession;
		if (!it) return;
		ms.metadata = new MediaMetadata({
			title: it.title,
			artist: it.artist,
			album: it.kind === 'set' ? 'Set · Rotor' : 'Own track · Rotor',
			artwork: it.cover ? [{ src: it.cover, sizes: '512x512' }] : []
		});
		ms.playbackState = this.playing ? 'playing' : 'paused';
		const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
			try {
				ms.setActionHandler(a, h);
			} catch {
				/* unsupported action */
			}
		};
		set('play', () => void this.toggle());
		set('pause', () => this.pause());
		set('seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime * 1000));
		set('seekbackward', (d) => this.skip(-(d.seekOffset ?? 15) * 1000));
		set('seekforward', (d) => this.skip((d.seekOffset ?? 15) * 1000));
		set('previoustrack', this.queue.length > 1 ? () => this.previous() : null);
		set('nexttrack', this.queue.length > 1 ? () => this.next() : null);
	}
}

export const ownPlayer = new OwnPlayer();
