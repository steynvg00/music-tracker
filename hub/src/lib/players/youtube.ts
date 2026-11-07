/**
 * YouTube IFrame Player API (R4). The player is YouTube's own, always visible (≥ 480×270 on
 * the laptop, full-width sheet on mobile, never below 200×200) and never modified: Rotor's
 * Previous/Next only call the API. No audio-only mode, no hidden or background player
 * (YouTube Developer Policies III.I.4/5/7/9). Privacy-enhanced host (youtube-nocookie.com).
 */

export const YT_API_URL = 'https://www.youtube.com/iframe_api';
export const YT_HOST = 'https://www.youtube-nocookie.com';

/** onStateChange values. */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;
/** onError codes that mean "this video can't play here" (removed / not embeddable). */
export const YT_UNPLAYABLE = new Set([100, 101, 150]);
export const YT_NOT_EMBEDDABLE = new Set([101, 150]);

interface YtPlayer {
	loadVideoById(id: string): void;
	cueVideoById(id: string): void;
	playVideo(): void;
	pauseVideo(): void;
	stopVideo(): void;
	destroy(): void;
}
interface YtNamespace {
	Player: new (el: HTMLElement, opts: Record<string, unknown>) => YtPlayer;
}
declare global {
	interface Window {
		YT?: YtNamespace;
		onYouTubeIframeAPIReady?: () => void;
	}
}

let loading: Promise<YtNamespace> | null = null;

export function loadYouTubeApi(): Promise<YtNamespace> {
	if (window.YT?.Player) return Promise.resolve(window.YT);
	loading ??= new Promise((resolve, reject) => {
		const prev = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			prev?.();
			if (window.YT?.Player) resolve(window.YT);
		};
		const s = document.createElement('script');
		s.src = YT_API_URL;
		s.async = true;
		s.onerror = () => {
			loading = null;
			reject(new Error('Could not load the YouTube player'));
		};
		document.head.appendChild(s);
	});
	return loading;
}

export interface YtController {
	load(videoId: string, autoplay: boolean): void;
	play(): void;
	pause(): void;
	destroy(): void;
}

export async function createYouTubePlayer(
	el: HTMLElement,
	on: { ready: () => void; state: (s: number) => void; error: (code: number) => void; autoplayBlocked: () => void }
): Promise<YtController> {
	const YT = await loadYouTubeApi();
	let p: YtPlayer | null = null;
	await new Promise<void>((resolve) => {
		p = new YT.Player(el, {
			width: '100%',
			height: '100%',
			host: YT_HOST,
			playerVars: { playsinline: 1, rel: 0, origin: location.origin },
			events: {
				onReady: () => {
					on.ready();
					resolve();
				},
				onStateChange: (e: { data: number }) => on.state(e.data),
				onError: (e: { data: number }) => on.error(e.data),
				onAutoplayBlocked: () => on.autoplayBlocked()
			}
		});
	});
	const player = p as unknown as YtPlayer;
	return {
		load: (id, autoplay) => (autoplay ? player.loadVideoById(id) : player.cueVideoById(id)),
		play: () => player.playVideo(),
		pause: () => player.pauseVideo(),
		destroy: () => player.destroy()
	};
}
