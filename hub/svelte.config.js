import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Spotify CDNs: cover art (i.scdn.co, mosaic.scdn.co, image-cdn-*.spotifycdn.com) and the
// Web Playback SDK (sdk.scdn.co), which runs its player inside its own iframe.
const SPOTIFY_IMG = ['https://i.scdn.co', 'https://mosaic.scdn.co', 'https://*.scdn.co', 'https://*.spotifycdn.com'];

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Vercel Hobby, functions next to Supabase eu-central-1 (04-architecture.md §1).
		adapter: adapter({ runtime: 'nodejs22.x', regions: ['fra1'] }),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// R4: YouTube IFrame API + SoundCloud Widget API (official players, loaded from their hosts).
				'script-src': ['self', 'https://sdk.scdn.co', 'https://www.youtube.com', 'https://s.ytimg.com', 'https://w.soundcloud.com'],
				// Svelte's style="" attributes need unsafe-inline; no inline scripts are allowed.
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', ...SPOTIFY_IMG, 'https://i.ytimg.com', 'https://*.sndcdn.com'],
				'font-src': ['self'],
				'connect-src': ['self', 'https://api.spotify.com', 'https://*.spotify.com', 'wss://*.spotify.com', 'https://*.scdn.co'],
				'frame-src': ['https://sdk.scdn.co', 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://w.soundcloud.com'],
				'media-src': ['self', 'blob:', 'https://*.scdn.co'],
				'worker-src': ['self'],
				'manifest-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		},
		// Mutating API routes are additionally Origin-checked in hooks.server.ts (JSON bodies
		// aren't covered by SvelteKit's built-in form CSRF check).
		csrf: { trustedOrigins: [] },
		// Absolute /_app/… asset URLs (R3 fix). With the default relative paths, a page the service
		// worker serves at another URL (the offline fallback) loads its scripts from the wrong folder
		// (/playlist/_app/…) and the app breaks instead of showing "offline". Rotor lives at the root.
		paths: { relative: false }
	}
};

export default config;
