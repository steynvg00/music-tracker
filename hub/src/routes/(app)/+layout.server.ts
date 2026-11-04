import { db } from '$lib/server/db';
import { connectionStatus } from '$lib/server/spotify/token';
import type { LayoutServerLoad } from './$types';

/** Token countdowns for the app-wide banner (amber ≤ 21 days, red ≤ 7 or invalid_grant). */
export const load: LayoutServerLoad = async ({ depends }) => {
	depends('rotor:connections');
	const c = await connectionStatus(db());
	return {
		connections: {
			hub: { health: c.hub.health, daysLeft: c.hub.daysLeft, lastError: c.hub.lastError, connected: c.hub.connected },
			cron: { health: c.cron.health, daysLeft: c.cron.daysLeft, lastError: c.cron.lastError, connected: c.cron.connected }
		}
	};
};
