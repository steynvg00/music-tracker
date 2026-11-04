/**
 * Spotify Web Playback SDK ("This laptop", 04-architecture.md §1). Loaded lazily from
 * sdk.scdn.co (allowed in the CSP); it runs Spotify's player in its own iframe. The
 * SDK needs a client-side access token: it gets a 1-hour token from /api/spotify/token,
 * never the refresh token.
 */
import type { PlayerSnapshot } from '$lib/shared/player-types';

export interface WebPlaybackImage {
	url: string;
	width?: number | null;
}
export interface WebPlaybackTrack {
	uri: string;
	id: string | null;
	type: 'track' | 'episode' | 'ad';
	name: string;
	duration_ms: number;
	is_playable?: boolean;
	album: { uri: string; name: string; images: WebPlaybackImage[] };
	artists: { uri: string; name: string }[];
}
export interface WebPlaybackState {
	context: { uri: string | null; metadata?: Record<string, unknown> | null };
	disallows: Record<string, boolean | undefined>;
	paused: boolean;
	position: number;
	duration: number;
	repeat_mode: 0 | 1 | 2;
	shuffle: boolean;
	timestamp: number;
	track_window: { current_track: WebPlaybackTrack | null; next_tracks: WebPlaybackTrack[]; previous_tracks: WebPlaybackTrack[] };
}

export interface SpotifyPlayer {
	connect(): Promise<boolean>;
	disconnect(): void;
	addListener(event: 'ready' | 'not_ready', cb: (d: { device_id: string }) => void): boolean;
	addListener(event: 'player_state_changed', cb: (s: WebPlaybackState | null) => void): boolean;
	addListener(
		event: 'initialization_error' | 'authentication_error' | 'account_error' | 'playback_error',
		cb: (e: { message: string }) => void
	): boolean;
	addListener(event: 'autoplay_failed', cb: () => void): boolean;
	getCurrentState(): Promise<WebPlaybackState | null>;
	togglePlay(): Promise<void>;
	pause(): Promise<void>;
	resume(): Promise<void>;
	nextTrack(): Promise<void>;
	previousTrack(): Promise<void>;
	seek(ms: number): Promise<void>;
	setVolume(v: number): Promise<void>;
	getVolume(): Promise<number>;
	activateElement(): Promise<void>;
}

export declare const SpotifyNamespace: {
	Player: new (opts: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume?: number }) => SpotifyPlayer;
};

export const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
export const SDK_DEVICE_NAME = 'Rotor · This laptop';
export type SdkMode = 'auto' | 'on' | 'off';
const MODE_KEY = 'rotor.sdk';

export function isIOS(): boolean {
	if (typeof navigator === 'undefined') return false;
	return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
}

export function isPhoneLike(): boolean {
	if (typeof window === 'undefined') return false;
	return isIOS() || /Android.+Mobile/.test(navigator.userAgent) || window.matchMedia('(max-width: 767px) and (pointer: coarse)').matches;
}

export function getSdkMode(): SdkMode {
	try {
		const v = localStorage.getItem(MODE_KEY);
		return v === 'on' || v === 'off' ? v : 'auto';
	} catch {
		return 'auto';
	}
}

export function setSdkMode(mode: SdkMode): void {
	try {
		localStorage.setItem(MODE_KEY, mode);
	} catch {
		/* private mode */
	}
}

/** Auto = laptops/desktops only. 'on' forces it (R1 spike e: SDK in the iPhone standalone PWA). */
export function sdkWanted(mode: SdkMode = getSdkMode()): boolean {
	if (typeof window === 'undefined' || mode === 'off') return false;
	if (typeof navigator.requestMediaKeySystemAccess !== 'function') return false; // needs EME
	return mode === 'on' || !isPhoneLike();
}

let loading: Promise<NonNullable<Window['Spotify']>> | null = null;

export function loadSdk(): Promise<NonNullable<Window['Spotify']>> {
	if (window.Spotify) return Promise.resolve(window.Spotify);
	if (loading) return loading;
	loading = new Promise((resolve, reject) => {
		window.onSpotifyWebPlaybackSDKReady = () => (window.Spotify ? resolve(window.Spotify) : reject(new Error('SDK missing')));
		const s = document.createElement('script');
		s.src = SDK_URL;
		s.async = true;
		s.onerror = () => {
			loading = null;
			reject(new Error('Could not load the Web Playback SDK'));
		};
		document.head.appendChild(s);
	});
	return loading;
}

function pickImage(images: WebPlaybackImage[]): { small: string | null; large: string | null } {
	if (!images?.length) return { small: null, large: null };
	const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
	return { small: (sorted.find((i) => (i.width ?? 0) <= 320) ?? sorted[sorted.length - 1]!).url, large: sorted[0]!.url };
}

/** SDK state → the same snapshot shape the proxy returns (pure; tested). */
export function sdkStateToSnapshot(state: WebPlaybackState, deviceId: string, volumePercent: number | null): PlayerSnapshot {
	const t = state.track_window.current_track;
	const img = t ? pickImage(t.album.images) : { small: null, large: null };
	const disallows: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(state.disallows ?? {})) if (v) disallows[k] = true;
	return {
		active: true,
		device: {
			id: deviceId,
			name: 'This laptop',
			type: 'Computer',
			isActive: true,
			isRestricted: false,
			supportsVolume: true,
			volumePercent
		},
		item: t
			? {
					uri: t.uri,
					type: t.type === 'episode' ? 'episode' : 'track',
					name: t.name,
					artists: t.artists.map((a) => ({ name: a.name, uri: a.uri })),
					albumName: t.album.name,
					imageUrl: img.small,
					imageUrlLarge: img.large,
					durationMs: state.duration || t.duration_ms,
					isLocal: false
				}
			: null,
		context: state.context?.uri ? { uri: state.context.uri, type: state.context.uri.split(':')[1] ?? 'unknown' } : null,
		isPlaying: !state.paused,
		progressMs: state.position,
		shuffle: state.shuffle,
		repeat: state.repeat_mode === 2 ? 'track' : state.repeat_mode === 1 ? 'context' : 'off',
		disallows
	};
}
