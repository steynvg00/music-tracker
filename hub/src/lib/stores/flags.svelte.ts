/**
 * Per-device experimental flags (v0.90). Stored in localStorage, so each device opts in on its own;
 * every flag is OFF by default and OFF wherever storage is unavailable (private mode, SSR).
 */
import { browser } from '$app/environment';

export const FLAG_KEYS = { artistPages: 'rotor.flag.artistPages' } as const;
export type FlagName = keyof typeof FLAG_KEYS;

function read(name: FlagName): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(FLAG_KEYS[name]) === '1';
	} catch {
		return false;
	}
}

class Flags {
	artistPages = $state(read('artistPages'));

	set(name: FlagName, on: boolean): void {
		this[name] = on;
		try {
			if (on) localStorage.setItem(FLAG_KEYS[name], '1');
			else localStorage.removeItem(FLAG_KEYS[name]);
		} catch {
			/* private mode: the flag lasts for this page only */
		}
	}
}

export const flags = new Flags();

/** Plain read for non-component code (load functions); false on the server. */
export function flagOn(name: FlagName): boolean {
	return read(name);
}
