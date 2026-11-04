import { db } from '$lib/server/db';
import { config } from '$lib/server/env';
import { connectionStatus } from '$lib/server/spotify/token';
import { mirrorAgeMs } from '$lib/server/spotify/mirror';
import type { PageServerLoad } from './$types';

const NOTICES: Record<string, string> = {
	'connected=cron': 'Crons connected. The next cron run uses this token instead of the GitHub secret.',
	'error=denied': 'You cancelled the Spotify dialog.',
	'error=not_owner': "That Spotify account isn't this Rotor's owner. Nothing was saved.",
	'error=state': 'The authorization expired. Try again.',
	'error=exchange': "Spotify didn't accept the authorization. Try again.",
	'error=cron_not_configured': "Add the cron app's Client ID and secret to the Vercel env first (see hub/.env.example).",
	'error=session': 'Sign in first.',
	'error=spotify': 'Spotify returned an error.'
};

export const load: PageServerLoad = async ({ url }) => {
	const sql = db();
	const cfg = config();
	const [connections, age, last] = await Promise.all([
		connectionStatus(sql),
		mirrorAgeMs(sql).catch(() => Number.POSITIVE_INFINITY),
		sql<{ t: Date | null }[]>`SELECT max(played_at) AS t FROM spotify_plays`
	]);
	const key = [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).find((k) => k in NOTICES);
	return {
		connections,
		cronConfigured: !!(cfg.cronClientId && cfg.cronClientSecret),
		cronClientMatches: !connections.cron.connected || connections.cron.spotifyClientId === cfg.cronClientId,
		reseedAvailable: !!cfg.githubDispatchToken,
		mirrorAgeMin: Number.isFinite(age) ? Math.round(age / 60000) : null,
		lastPlayAt: last[0]?.t ? new Date(last[0].t).toISOString() : null,
		notice: key ? { text: NOTICES[key]!, error: key.startsWith('error') } : null
	};
};
