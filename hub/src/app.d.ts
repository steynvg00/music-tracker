// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			session: import('$lib/server/session').SessionInfo | null;
		}
		interface Error {
			message: string;
			code?: string;
		}
	}

	interface Window {
		onSpotifyWebPlaybackSDKReady?: () => void;
		Spotify?: typeof import('$lib/player/spotify-sdk').SpotifyNamespace;
	}
}

export {};
