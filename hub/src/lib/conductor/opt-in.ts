/** Mixed sessions are opt-in per device (R5): a localStorage flag, set only after the policy warning. */
import { MIXES_OPT_IN_KEY } from './machine';

export function mixesEnabled(): boolean {
	try {
		return localStorage.getItem(MIXES_OPT_IN_KEY) === 'on';
	} catch {
		return false;
	}
}

export function setMixesEnabled(on: boolean): void {
	try {
		if (on) localStorage.setItem(MIXES_OPT_IN_KEY, 'on');
		else localStorage.removeItem(MIXES_OPT_IN_KEY);
	} catch {
		/* private mode: stays off */
	}
}

export const POLICY_WARNING =
	'Mixed sessions put Spotify and YouTube/SoundCloud in one session. That conflicts with Spotify’s Developer Policy (III.5, III.7). If Spotify enforced it, the app’s developer account could be revoked — which would also stop the crons that maintain your managed playlists. Turn it on for this device only?';
