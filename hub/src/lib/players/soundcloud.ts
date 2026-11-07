/**
 * SoundCloud HTML5 Widget API (R4), no key needed. The widget is SoundCloud's own visible
 * iframe; Rotor's Previous/Next call widget.prev()/next(). Go+ tracks play as 30-second
 * previews in embeds: the widget reports them (`policy: 'SNIP'`) and Rotor skips them.
 */

export const SC_API_URL = 'https://w.soundcloud.com/player/api.js';
export const SC_PLAYER = 'https://w.soundcloud.com/player/';

export function widgetSrc(url: string): string {
	const q = new URLSearchParams({ url, auto_play: 'false', visual: 'true', show_comments: 'false', show_reposts: 'false' });
	return `${SC_PLAYER}?${q}`;
}

export interface ScSound {
	title?: string;
	policy?: string;
	duration?: number;
	full_duration?: number;
}
interface ScWidget {
	bind(event: string, cb: (e?: unknown) => void): void;
	play(): void;
	pause(): void;
	next(): void;
	prev(): void;
	skip(i: number): void;
	getCurrentSound(cb: (s: ScSound | null) => void): void;
	getCurrentSoundIndex(cb: (i: number) => void): void;
	getSounds(cb: (s: ScSound[]) => void): void;
}
interface ScNamespace {
	Widget: ((el: HTMLIFrameElement) => ScWidget) & { Events: Record<'READY' | 'PLAY' | 'PAUSE' | 'FINISH' | 'ERROR', string> };
}
declare global {
	interface Window {
		SC?: ScNamespace;
	}
}

let loading: Promise<ScNamespace> | null = null;

export function loadSoundCloudApi(): Promise<ScNamespace> {
	if (window.SC?.Widget) return Promise.resolve(window.SC);
	loading ??= new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = SC_API_URL;
		s.async = true;
		s.onload = () => (window.SC?.Widget ? resolve(window.SC) : reject(new Error('SoundCloud widget API missing')));
		s.onerror = () => {
			loading = null;
			reject(new Error('Could not load the SoundCloud player'));
		};
		document.head.appendChild(s);
	});
	return loading;
}

/** A Go+ track only plays a snippet in embeds. */
export function isPreview(s: ScSound | null | undefined): boolean {
	if (!s) return false;
	return s.policy === 'SNIP' || (!!s.full_duration && !!s.duration && s.full_duration > s.duration + 1000);
}

export interface ScController {
	play(): void;
	pause(): void;
	next(): void;
	prev(): void;
	current(): Promise<ScSound | null>;
}

export async function createSoundCloudWidget(
	iframe: HTMLIFrameElement,
	on: { ready: () => void; play: () => void; pause: () => void; finish: () => void; error: () => void }
): Promise<ScController> {
	const SC = await loadSoundCloudApi();
	const w = SC.Widget(iframe);
	await new Promise<void>((resolve) => {
		w.bind(SC.Widget.Events.READY, () => {
			on.ready();
			resolve();
		});
	});
	w.bind(SC.Widget.Events.PLAY, () => on.play());
	w.bind(SC.Widget.Events.PAUSE, () => on.pause());
	w.bind(SC.Widget.Events.FINISH, () => on.finish());
	w.bind(SC.Widget.Events.ERROR, () => on.error());
	return {
		play: () => w.play(),
		pause: () => w.pause(),
		next: () => w.next(),
		prev: () => w.prev(),
		current: () => new Promise((r) => w.getCurrentSound((s) => r(s)))
	};
}
