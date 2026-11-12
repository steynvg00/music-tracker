/**
 * Mixed-session conductor, pure part (R5, 01-feasibility.md §6.2–6.3). No I/O: the store in
 * conductor.svelte.ts feeds it Spotify snapshots and player events and runs the effects.
 *
 *   PREPARE → SPOTIFY_RUN → HANDOFF → IN-APP RUN (YouTube | SoundCloud) → … → ENDED
 *                 │ user skips / plays something else  → DIVERGED (resume or end)
 *                 │ Spotify keeps going after the run   → pause it (F3), carry on
 * Spotify's own queue is never used: every Spotify run is played as a fresh `uris` list, and
 * nothing overlaps (III.7): the next source starts only after the previous one stopped.
 */

export type MixSource = 'spotify' | 'youtube' | 'soundcloud';

export interface MixItem {
	position: number;
	source: MixSource;
	spotifyUri: string | null;
	mediaItemId: string | null;
	/** YouTube video id / SoundCloud URL, for in-app items. */
	sourceId: string | null;
	title: string;
	artist: string | null;
	durationMs: number | null;
	/** In-app items that can't play here (not embeddable, preview, unavailable). */
	skip?: boolean;
}

export interface Run {
	source: MixSource;
	start: number;
	end: number; // inclusive
}

/** Consecutive items of the same source form a run (skipped items are left out). */
export function runs(items: MixItem[]): Run[] {
	const out: Run[] = [];
	items.forEach((it, i) => {
		if (it.skip) return;
		const last = out.at(-1);
		if (last && last.source === it.source && items.slice(last.end + 1, i).every((x) => x.skip)) last.end = i;
		else out.push({ source: it.source, start: i, end: i });
	});
	return out;
}

export function runAt(rs: Run[], index: number): Run | null {
	return rs.find((r) => index >= r.start && index <= r.end) ?? null;
}

export function nextRun(rs: Run[], run: Run | null): Run | null {
	if (!run) return rs[0] ?? null;
	return rs.find((r) => r.start > run.end) ?? null;
}

/** Spotify URIs of a run from `from` on (≤ 100: one play call). */
export function runUris(items: MixItem[], run: Run, from = run.start): string[] {
	return items
		.slice(Math.max(from, run.start), run.end + 1)
		.filter((i) => !i.skip && i.spotifyUri)
		.map((i) => i.spotifyUri!)
		.slice(0, 100);
}

// ── Preconditions (F5: same output device) ───────────────────────────────────

export type Mode = 'laptop' | 'relay';
export type Precheck = { ok: true } | { ok: false; reason: 'no_device' | 'other_device'; deviceName: string | null };

/**
 * Laptop: Spotify must play on "This laptop" (the Web Playback SDK in this page), so YouTube and
 * Spotify come out of the same speakers. iPhone (relay): Spotify must play on a phone.
 */
export function precheck(mode: Mode, device: { id: string | null; name: string; type: string } | null, sdkDeviceId: string | null): Precheck {
	if (!device) return { ok: false, reason: 'no_device', deviceName: null };
	if (mode === 'laptop') return device.id && device.id === sdkDeviceId ? { ok: true } : { ok: false, reason: 'other_device', deviceName: device.name };
	return device.type.toLowerCase() === 'smartphone' ? { ok: true } : { ok: false, reason: 'other_device', deviceName: device.name };
}

// ── Watching a Spotify run ───────────────────────────────────────────────────

export interface Expect {
	uris: string[];
	/** Index in `uris` we believe is playing. */
	index: number;
	/** Wall-clock ms when that item started, estimated from snapshots (now − progress), and its duration. */
	itemStartedAt: number;
	duration: number;
	/** True until Spotify has confirmed the run started (first snapshot with our first URI). */
	starting: boolean;
}

export interface Snapshot {
	isPlaying: boolean;
	itemUri: string | null;
	progressMs: number;
	durationMs: number;
	contextUri: string | null;
}

export type Observation =
	| { kind: 'waiting' }
	| { kind: 'playing'; index: number }
	| { kind: 'paused' }
	| { kind: 'run_end' }
	| { kind: 'autoplay' }
	| { kind: 'diverged'; why: 'skipped' | 'other' | 'context' };

/** "Near the end": within this of the duration counts as finished (polling, rounding, crossfade). */
export const END_SLACK_MS = 4000;
export function slack(durationMs: number): number {
	return Math.min(END_SLACK_MS, Math.max(1000, Math.round(durationMs * 0.2)));
}

/**
 * Classify a Spotify snapshot. Whether the current item has (nearly) run its course is judged
 * by elapsed wall-clock time since it started, not by the last polled progress, so an irregular
 * poll can't turn a natural advance into a "skip".
 */
export function observe(e: Expect, s: Snapshot, now: number): Observation {
	const lastIndex = e.uris.length - 1;
	const nearEnd = e.duration > 0 && now - e.itemStartedAt >= e.duration - slack(e.duration);
	if (e.starting) {
		if (s.itemUri === e.uris[0] && s.isPlaying) return { kind: 'playing', index: 0 };
		return { kind: 'waiting' };
	}
	if (s.contextUri) return { kind: 'diverged', why: 'context' }; // the user started a playlist/album
	const idx = s.itemUri ? e.uris.indexOf(s.itemUri) : -1;
	if (idx === -1) {
		if (!s.itemUri) return e.index === lastIndex ? { kind: 'run_end' } : { kind: 'diverged', why: 'other' };
		// Something outside the run: Spotify autoplay after our last track (F3), or the user.
		return e.index === lastIndex && nearEnd ? { kind: 'autoplay' } : { kind: 'diverged', why: 'other' };
	}
	if (idx === e.index) {
		if (s.isPlaying) return { kind: 'playing', index: idx };
		// Stopped on our last track at its end (or reset to 0 after it): the run is over.
		if (idx === lastIndex && (s.progressMs === 0 || s.progressMs >= s.durationMs - slack(s.durationMs) || nearEnd)) return { kind: 'run_end' };
		return { kind: 'paused' };
	}
	if (idx === e.index + 1) return nearEnd ? { kind: 'playing', index: idx } : { kind: 'diverged', why: 'skipped' };
	return { kind: 'diverged', why: 'skipped' };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export const MIXES_OPT_IN_KEY = 'rotor.mixedSessions';
