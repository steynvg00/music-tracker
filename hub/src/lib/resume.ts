/**
 * v0.92: reopen the PWA where you left it. The app saves the open page and its scroll position when it
 * goes to the background; a cold start of the installed app on its start page (/home) goes back there.
 * Pure rules here (tested); the wiring is in routes/(app)/+layout.svelte.
 */
export const RESUME_KEY = 'rotor.resume';
export const RESUME_MAX_AGE_MS = 12 * 3_600_000;

export interface Saved {
	path: string;
	scrollY: number;
	at: number;
}

/** Paths worth returning to (no auth / one-off pages). */
export function resumable(path: string): boolean {
	return path.startsWith('/') && !/^\/(auth|login|offline|wrapped\/)/.test(path) && path.length < 300;
}

export function parseSaved(raw: string | null): Saved | null {
	if (!raw) return null;
	try {
		const s = JSON.parse(raw) as Saved;
		return typeof s.path === 'string' && Number.isFinite(s.scrollY) && Number.isFinite(s.at) ? s : null;
	} catch {
		return null;
	}
}

/** Where a cold start should go: null = stay. Only the installed app, only from its start page. */
export function resumeTarget(o: { standalone: boolean; path: string; saved: Saved | null; now: number; firstLoad: boolean }): Saved | null {
	if (!o.standalone || !o.firstLoad || !o.saved) return null;
	if (o.now - o.saved.at > RESUME_MAX_AGE_MS) return null;
	if (o.path !== '/home' && o.path !== '/') return null;
	if (!resumable(o.saved.path)) return null;
	return o.saved;
}
