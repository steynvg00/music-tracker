import { env } from '$env/dynamic/private';

/** Server config, read lazily so `vite build` needs no secrets. See hub/.env.example. */
export interface HubConfig {
	origin: string;
	hubClientId: string;
	hubClientSecret: string;
	cronClientId: string | null;
	cronClientSecret: string | null;
	ownerSpotifyId: string;
	databaseUrl: string;
	sessionSecret: string;
	tokenEncKey: string;
	githubDispatchToken: string | null;
	githubRepository: string;
	/** Web Push application server key (public; the private key lives only in GitHub secrets). */
	vapidPublicKey: string | null;
}

export class ConfigError extends Error {}

function required(name: string): string {
	const v = env[name]?.trim();
	if (!v) throw new ConfigError(`Missing environment variable ${name} (see hub/.env.example)`);
	return v;
}

function optional(name: string): string | null {
	const v = env[name]?.trim();
	return v ? v : null;
}

let cached: HubConfig | null = null;

export function config(): HubConfig {
	if (cached) return cached;
	cached = {
		origin: required('ORIGIN').replace(/\/+$/, ''),
		hubClientId: required('SPOTIFY_CLIENT_ID'),
		hubClientSecret: required('SPOTIFY_CLIENT_SECRET'),
		cronClientId: optional('SPOTIFY_CRON_CLIENT_ID'),
		cronClientSecret: optional('SPOTIFY_CRON_CLIENT_SECRET'),
		ownerSpotifyId: required('OWNER_SPOTIFY_ID'),
		databaseUrl: required('DATABASE_URL'),
		sessionSecret: required('SESSION_SECRET'),
		tokenEncKey: required('TOKEN_ENC_KEY'),
		githubDispatchToken: optional('GITHUB_DISPATCH_TOKEN'),
		githubRepository: optional('GITHUB_REPOSITORY') ?? 'steynvg00/music-tracker',
		vapidPublicKey: optional('VAPID_PUBLIC_KEY')
	};
	return cached;
}

export function redirectUri(cfg: HubConfig = config()): string {
	return `${cfg.origin}/auth/callback`;
}
