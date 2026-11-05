/**
 * Elsewhere (R4): YouTube + SoundCloud collections, a separate space from Spotify
 * (03-ux-ia.md §3). Shared by server and UI. Nothing here ever mixes with Spotify lists.
 */

export type Source = 'youtube' | 'soundcloud';
export type CollectionKind = 'playlist' | 'set' | 'likes_set' | 'manual';

export const SOURCE_LABEL: Record<Source, string> = { youtube: 'YouTube', soundcloud: 'SoundCloud' };

export interface MediaItem {
	id: string;
	source: Source;
	sourceId: string;
	title: string;
	artist: string | null;
	durationMs: number | null;
	artworkUrl: string | null;
	embeddable: boolean | null;
	previewOnly: boolean;
	unavailable: boolean;
	position: number;
}

export interface Collection {
	id: string;
	source: Source;
	sourceCollectionId: string;
	kind: CollectionKind;
	title: string;
	owner: string | null;
	url: string;
	artworkUrl: string | null;
	itemCount: number;
	embedHtml: string | null;
	importedAt: string;
	lastSyncedAt: string;
	lastImportUnits: number | null;
}

export interface CollectionDetail extends Collection {
	items: MediaItem[];
	/** Items older than this need a refresh (YouTube API III.E.4: 30 days). */
	staleAfter: string;
}

/** What a pasted link means. `error` = a link we can't (or may not) import, with the reason. */
export type ParsedLink =
	| { source: 'youtube'; kind: 'playlist'; id: string; url: string }
	| { source: 'youtube'; kind: 'manual'; id: string; url: string }
	| { source: 'soundcloud'; kind: 'set' | 'manual'; id: string; url: string }
	| { error: string };

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const SC_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/;
const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;
const SC_SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const SC_SECRET = /^s-[A-Za-z0-9]{4,40}$/;

export function parseLink(raw: string): ParsedLink {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return { error: 'Paste a full YouTube or SoundCloud link (https://…)' };
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Paste a full YouTube or SoundCloud link (https://…)' };
	const host = u.hostname.toLowerCase();
	if (YT_HOSTS.has(host)) {
		const list = u.searchParams.get('list');
		if (list) {
			if (list === 'LL' || list === 'WL' || list === 'LM') {
				return { error: 'Liked videos and Watch later are private. Copy them into an unlisted playlist and import that.' };
			}
			if (list.startsWith('RD')) return { error: 'YouTube Mixes are generated on the fly and can’t be imported. Save it as a playlist first.' };
			if (!YT_LIST.test(list)) return { error: 'That doesn’t look like a YouTube playlist link' };
			return { source: 'youtube', kind: 'playlist', id: list, url: `https://www.youtube.com/playlist?list=${list}` };
		}
		const v = host === 'youtu.be' ? u.pathname.slice(1) : u.pathname === '/watch' ? u.searchParams.get('v') : null;
		if (v && YT_VIDEO.test(v)) return { source: 'youtube', kind: 'manual', id: v, url: `https://www.youtube.com/watch?v=${v}` };
		return { error: 'Paste a YouTube playlist link (…/playlist?list=…) or a video link' };
	}
	if (host === 'on.soundcloud.com') return { error: 'Short SoundCloud links can’t be read without opening them. Open it and copy the full soundcloud.com link.' };
	if (SC_HOSTS.has(host)) {
		const parts = u.pathname.split('/').filter(Boolean);
		if (parts.length >= 2 && parts[1] === 'likes') {
			return { error: 'SoundCloud has no keyless way to read likes. Add the tracks to a set (playlist) and import that.' };
		}
		if (parts.length >= 3 && parts[1] === 'sets' && SC_SLUG.test(parts[0]!) && SC_SLUG.test(parts[2]!) && (parts.length === 3 || (parts.length === 4 && SC_SECRET.test(parts[3]!)))) {
			const url = `https://soundcloud.com/${parts.join('/')}`;
			return { source: 'soundcloud', kind: 'set', id: url, url };
		}
		if ((parts.length === 2 || (parts.length === 3 && SC_SECRET.test(parts[2]!))) && SC_SLUG.test(parts[0]!) && SC_SLUG.test(parts[1]!) && parts[1] !== 'sets') {
			const url = `https://soundcloud.com/${parts.join('/')}`;
			return { source: 'soundcloud', kind: 'manual', id: url, url };
		}
		return { error: 'Paste a SoundCloud set (…/sets/…) or track link' };
	}
	return { error: 'Only YouTube and SoundCloud links can be imported' };
}

/** ISO-8601 duration (YouTube contentDetails.duration, e.g. PT1H2M3S) → ms. */
export function isoDurationMs(iso: string | null | undefined): number | null {
	const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? '');
	if (!m || iso === 'P' || iso === 'PT') return null;
	const [, d, h, mi, s] = m.map((x) => Number(x ?? 0));
	return ((d! * 24 + h!) * 3600 + mi! * 60 + s!) * 1000;
}

/** Playable inside Rotor: embeddable (or unknown), available, and not a 30-second preview. */
export function playable(i: Pick<MediaItem, 'embeddable' | 'previewOnly' | 'unavailable'>): boolean {
	return i.embeddable !== false && !i.previewOnly && !i.unavailable;
}

/** Next/previous within ONE collection only (R4), skipping items that can't play here. */
export function step(items: Pick<MediaItem, 'embeddable' | 'previewOnly' | 'unavailable'>[], from: number, dir: 1 | -1): number | null {
	for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (playable(items[i]!)) return i;
	return null;
}

export const REFRESH_DAYS = 30;
/** We refresh a few days before the 30-day limit so a missed daily run never breaks the rule. */
export const REFRESH_SOON_DAYS = 25;

/** Minimum visible player size (YouTube: ≥ 200×200; Rotor uses 480×270 on the laptop). */
export const YT_MIN = { laptop: { w: 480, h: 270 }, any: { w: 200, h: 200 } } as const;
