import type { ClientInit } from '@sveltejs/kit';

/**
 * v0.83.2: runs once the app's entry modules have loaded, BEFORE hydration waits for any data.
 * Tells static/boot-guard.js the shell is fine, so a slow first load (cold function, slow
 * /api/home, a first service-worker install) never shows the "taking long to start" bar/panel.
 */
export const init: ClientInit = () => {
	(window as unknown as { __rotorBoot?: { shellLoaded?: () => void } }).__rotorBoot?.shellLoaded?.();
};
