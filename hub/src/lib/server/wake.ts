/**
 * Pending-intent wake flow, server half (03-ux-ia.md §8).
 *
 * "Spotify isn't open anywhere" → the user taps Open Spotify. The client fires
 * POST /api/player/wake with what it wanted to play, then the spotify: deep link
 * opens the Spotify app. iOS suspends the PWA right away, so the waiting happens
 * here: poll /me/player/devices every second for up to 12 s and run the intent on the
 * first device that appears. The user never taps Play twice.
 */
import type { PlayerDevice } from '$lib/shared/player-types';
import { pickWakeDevice } from './spotify/player';

export interface WakeOptions {
	listDevices: () => Promise<PlayerDevice[]>;
	run: (deviceId: string) => Promise<void>;
	prefer: string | null;
	knownIds: string[];
	timeoutMs?: number;
	intervalMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export type WakeResult = { status: 'played'; device: PlayerDevice } | { status: 'timeout' };

export async function wakeAndRun(o: WakeOptions): Promise<WakeResult> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + (o.timeoutMs ?? 12_000);
	const interval = o.intervalMs ?? 1000;
	for (;;) {
		const device = pickWakeDevice(await o.listDevices().catch(() => []), o.prefer, o.knownIds);
		if (device?.id) {
			await o.run(device.id);
			return { status: 'played', device };
		}
		if (now() + interval > deadline) return { status: 'timeout' };
		await sleep(interval);
	}
}
