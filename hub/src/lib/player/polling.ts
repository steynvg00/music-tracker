/**
 * Pure polling + optimistic-overlay rules for the now-playing store
 * (01-feasibility.md §1.4, 04-architecture.md §6.1). Unit-tested in polling.test.ts.
 *
 *   visible + playing   every 5 s, plus one poll at track end (remaining + 400 ms)
 *   visible + paused    every 15 s
 *   hidden              no polling at all (poll once on visibilitychange)
 *   SDK is the device   no polling (Web Playback SDK events drive the state)
 *   429                 honour Retry-After; QUOTA_EXCEEDED → at least 30 s
 */
import type { PlayerSnapshot } from '$lib/shared/player-types';

export const PLAYING_MS = 5000;
export const PAUSED_MS = 15000;
export const QUOTA_MS = 30000;
export const TRACK_END_SLACK_MS = 400;
export const CONFIRM_DELAYS_MS = [300, 1200] as const;
export const OVERLAY_MAX_AGE_MS = 5000;

export interface PollInput {
	visible: boolean;
	sdkDriving: boolean;
	isPlaying: boolean;
	/** duration − interpolated position, when a track is playing. */
	remainingMs: number | null;
	now: number;
	rateLimitedUntil: number;
	quotaLimited: boolean;
}

export function nextPollDelay(i: PollInput): number | null {
	if (!i.visible || i.sdkDriving) return null;
	let d = i.isPlaying ? PLAYING_MS : PAUSED_MS;
	if (i.isPlaying && i.remainingMs !== null && i.remainingMs >= 0) d = Math.min(d, i.remainingMs + TRACK_END_SLACK_MS);
	if (i.quotaLimited) d = Math.max(d, QUOTA_MS);
	if (i.rateLimitedUntil > i.now) d = Math.max(d, i.rateLimitedUntil - i.now);
	return Math.max(Math.round(d), 250);
}

/** Interpolated position: progress + elapsed while playing, clamped to the duration. */
export function interpolate(progressMs: number, fetchedAt: number, now: number, isPlaying: boolean, durationMs: number): number {
	const p = isPlaying ? progressMs + Math.max(0, now - fetchedAt) : progressMs;
	return durationMs > 0 ? Math.min(Math.max(p, 0), durationMs) : Math.max(p, 0);
}

export interface Overlay {
	kind: string;
	issuedAt: number;
	mismatches: number;
	/** What the UI shows until Spotify confirms. */
	apply: (s: PlayerSnapshot) => PlayerSnapshot;
	/** True once a polled snapshot reflects the command. */
	confirmed: (s: PlayerSnapshot) => boolean;
}

/** Clear on confirmation; roll back after 2 mismatching polls or when stale. */
export function reconcile(o: Overlay | null, polled: PlayerSnapshot, now: number): { overlay: Overlay | null; rolledBack: boolean } {
	if (!o) return { overlay: null, rolledBack: false };
	if (o.confirmed(polled)) return { overlay: null, rolledBack: false };
	const mismatches = o.mismatches + 1;
	if (mismatches >= 2 || now - o.issuedAt > OVERLAY_MAX_AGE_MS) return { overlay: null, rolledBack: true };
	return { overlay: { ...o, mismatches }, rolledBack: false };
}

export const overlays = {
	playPause(playing: boolean, now: number): Overlay {
		return {
			kind: playing ? 'play' : 'pause',
			issuedAt: now,
			mismatches: 0,
			apply: (s) => ({ ...s, isPlaying: playing }),
			confirmed: (s) => s.isPlaying === playing
		};
	},
	seek(positionMs: number, now: number): Overlay {
		return {
			kind: 'seek',
			issuedAt: now,
			mismatches: 0,
			apply: (s) => ({ ...s, progressMs: positionMs }),
			confirmed: (s) => Math.abs(s.progressMs - positionMs) < 3000
		};
	},
	shuffle(state: boolean, now: number): Overlay {
		return { kind: 'shuffle', issuedAt: now, mismatches: 0, apply: (s) => ({ ...s, shuffle: state }), confirmed: (s) => s.shuffle === state };
	},
	repeat(state: PlayerSnapshot['repeat'], now: number): Overlay {
		return { kind: 'repeat', issuedAt: now, mismatches: 0, apply: (s) => ({ ...s, repeat: state }), confirmed: (s) => s.repeat === state };
	},
	volume(pct: number, now: number): Overlay {
		return {
			kind: 'volume',
			issuedAt: now,
			mismatches: 0,
			apply: (s) => (s.device ? { ...s, device: { ...s.device, volumePercent: pct } } : s),
			confirmed: (s) => Math.abs((s.device?.volumePercent ?? pct) - pct) <= 2
		};
	},
	skip(fromUri: string | null, now: number): Overlay {
		return {
			kind: 'skip',
			issuedAt: now,
			mismatches: 0,
			apply: (s) => ({ ...s, progressMs: 0, isPlaying: true }),
			confirmed: (s) => (s.item?.uri ?? null) !== fromUri
		};
	}
};

export function nextRepeat(r: PlayerSnapshot['repeat']): PlayerSnapshot['repeat'] {
	return r === 'off' ? 'context' : r === 'context' ? 'track' : 'off';
}
