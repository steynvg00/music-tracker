/**
 * DJ / live sets (v0.94): validation, the paste-a-tracklist parser and seek helpers. Pure.
 * Sources: YouTube or SoundCloud (their official, visible players, R4 rules) or your own upload
 * (Rotor's audio player). A tracklist entry links a catalog track, an own track, or stays an "ID".
 */
import { isPlaceholder, parseDuration, soundcloudUrl, youtubeId, type ArtistLink } from './own';

export type SetSource = 'youtube' | 'soundcloud' | 'upload';
export const SET_SOURCE_LABEL: Record<SetSource, string> = { youtube: 'YouTube', soundcloud: 'SoundCloud', upload: 'Upload' };

export type EntryKind = 'catalog' | 'own' | 'id';
export interface TracklistEntry {
	startMs: number | null;
	kind: EntryKind;
	trackUri: string | null;
	ownTrackId: string | null;
	artist: string | null;
	title: string;
}

export interface DjSet {
	id: string;
	title: string;
	event: string | null;
	date: string | null;
	durationMs: number;
	cover: string | null;
	coverUrl: string | null;
	coverObjectId: string | null;
	source: SetSource;
	youtubeId: string | null;
	soundcloudUrl: string | null;
	audio: { id: string; contentType: string; size: number; name: string | null } | null;
	artists: ArtistLink[];
	tracklist: TracklistEntry[];
	createdAt: string;
}
export type DjSetSummary = Omit<DjSet, 'tracklist'> & { entries: number };

// ── paste-a-tracklist ────────────────────────────────────────────────────────

export interface ParsedLine {
	line: number;
	startMs: number | null;
	artist: string | null;
	title: string;
	isId: boolean;
}

const TS = String.raw`(\d{1,2}:\d{2}(?::\d{2})?)`;
const LEAD = new RegExp(String.raw`^\s*(?:\d{1,3}[.)]\s*)?[[(]?${TS}[\])]?\s*(?:[-–—|:.]\s*)?(.*)$`);
const TRAIL = new RegExp(String.raw`^\s*(?:\d{1,3}[.)]\s*)?(.*?)\s*[[(]${TS}[\])]\s*$`);
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

function splitArtistTitle(s: string): { artist: string | null; title: string } {
	const m = /\s+[-–—]\s+/.exec(s);
	if (!m) return { artist: null, title: s.trim() };
	return { artist: s.slice(0, m.index).trim() || null, title: s.slice(m.index + m[0].length).trim() };
}

/** "00:00 Artist - Title", "[1:02:03] Artist – Title", "01. Artist - Title (12:30)", "ID - ID". */
export function parseTracklist(text: string): ParsedLine[] {
	const out: ParsedLine[] = [];
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	lines.forEach((raw, i) => {
		const line = raw.replace(/ /g, ' ').trim();
		if (!line || /^(#|\/\/|tracklist\b)/i.test(line)) return;
		let startMs: number | null = null;
		let rest = line;
		const lead = LEAD.exec(line);
		const trail = lead ? null : TRAIL.exec(line);
		if (lead && lead[2]!.trim()) {
			startMs = parseDuration(lead[1]!);
			rest = lead[2]!;
		} else if (trail && trail[1]!.trim()) {
			startMs = parseDuration(trail[2]!);
			rest = trail[1]!;
		} else {
			const n = NUMBERED.exec(line);
			if (n) rest = n[1]!;
		}
		const { artist, title } = splitArtistTitle(rest.trim());
		if (!title) return;
		const isId = isPlaceholder(title) || /^id$/i.test(title) || (artist !== null && /^id$/i.test(artist) && /^id$/i.test(title));
		out.push({ line: i + 1, startMs, artist, title, isId });
	});
	return out;
}

/** Index of the entry playing at `ms` (the last one whose start is ≤ ms), or -1. */
export function entryIndexAt(entries: { startMs: number | null }[], ms: number): number {
	let best = -1;
	let bestStart = -1;
	entries.forEach((e, i) => {
		if (e.startMs !== null && e.startMs <= ms && e.startMs >= bestStart) {
			best = i;
			bestStart = e.startMs;
		}
	});
	return best;
}

// ── validation ───────────────────────────────────────────────────────────────

export type SetErrors = Partial<Record<'title' | 'artists' | 'event' | 'date' | 'duration' | 'cover' | 'source' | 'tracklist', string>>;
export interface CleanSet {
	title: string;
	event: string | null;
	date: string | null;
	durationMs: number;
	coverUrl: string | null;
	coverObjectId: string | null;
	source: SetSource;
	youtubeId: string | null;
	soundcloudUrl: string | null;
	audioObjectId: string | null;
	artists: ArtistLink[];
	tracklist: TracklistEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function validateSet(raw: unknown): { ok: true; value: CleanSet } | { ok: false; errors: SetErrors } {
	const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const e: SetErrors = {};
	const title = str(b.title);
	if (!title) e.title = 'Title is required';
	else if (isPlaceholder(title)) e.title = `“${title}” is a placeholder, not a title`;
	else if (title.length > 200) e.title = 'At most 200 characters';
	const artists: ArtistLink[] = [];
	if (!Array.isArray(b.artists) || !b.artists.length) e.artists = 'At least one DJ / artist is required';
	else
		for (const a of b.artists as Record<string, unknown>[]) {
			const ok =
				a &&
				typeof a.name === 'string' &&
				!isPlaceholder(a.name) &&
				((a.kind === 'spotify' && typeof a.id === 'string' && /^[A-Za-z0-9]{22}$/.test(a.id)) || (a.kind === 'rotor' && typeof a.id === 'string' && UUID.test(a.id)));
			if (!ok) {
				e.artists = 'Every DJ / artist must be linked to an artist in your data, or created explicitly';
				break;
			}
			artists.push({ kind: a.kind as 'spotify' | 'rotor', id: a.id as string, name: (a.name as string).trim() });
		}
	const event = str(b.event);
	if (event && (event.length > 200 || isPlaceholder(event))) e.event = 'Enter the event or leave it empty';
	const date = str(b.date);
	if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) e.date = 'Use a full date';
	const durationMs = typeof b.durationMs === 'number' ? parseDuration(b.durationMs) : parseDuration(b.durationMs as string | null);
	if (!durationMs) e.duration = 'Duration is required (h:mm:ss)';
	else if (durationMs > 86_400_000) e.duration = 'At most 24 hours';
	const coverUrl = str(b.coverUrl);
	if (coverUrl && !/^https:\/\/\S+$/.test(coverUrl)) e.cover = 'Cover link must start with https://';
	const coverObjectId = str(b.coverObjectId);
	if (coverObjectId && !UUID.test(coverObjectId)) e.cover = 'Unknown cover file';
	const yt = youtubeId(str(b.youtubeUrl));
	const sc = soundcloudUrl(str(b.soundcloudUrl));
	const audio = str(b.audioObjectId);
	const given = [str(b.youtubeUrl), str(b.soundcloudUrl), audio].filter(Boolean).length;
	let source: SetSource | null = null;
	if (given !== 1) e.source = given ? 'One source per set: YouTube, SoundCloud or an upload' : 'Add the set’s source: a YouTube link, a SoundCloud link or an upload';
	else if (str(b.youtubeUrl)) yt ? (source = 'youtube') : (e.source = 'Not a YouTube video link');
	else if (str(b.soundcloudUrl)) sc ? (source = 'soundcloud') : (e.source = 'Not a SoundCloud link');
	else if (audio && UUID.test(audio)) source = 'upload';
	else e.source = 'Unknown audio file';
	const tracklist: TracklistEntry[] = [];
	const tl = b.tracklist === undefined || b.tracklist === null ? [] : b.tracklist;
	if (!Array.isArray(tl) || tl.length > 300) e.tracklist = 'At most 300 tracklist entries';
	else
		for (const [i, x] of (tl as Record<string, unknown>[]).entries()) {
			const startMs = x.startMs === null || x.startMs === undefined || x.startMs === '' ? null : typeof x.startMs === 'number' ? x.startMs : parseDuration(String(x.startMs));
			const kind = x.kind;
			const t = str(x.title);
			const bad = (msg: string) => (e.tracklist = `Entry ${i + 1}: ${msg}`);
			if (startMs !== null && (!Number.isFinite(startMs) || startMs < 0)) {
				bad('timestamp as m:ss or h:mm:ss');
				break;
			}
			if (startMs !== null && durationMs && startMs > durationMs) {
				bad('starts after the end of the set');
				break;
			}
			if (kind === 'catalog' && !(typeof x.trackUri === 'string' && TRACK_URI.test(x.trackUri))) {
				bad('not a track from your catalog');
				break;
			}
			if (kind === 'own' && !(typeof x.ownTrackId === 'string' && UUID.test(x.ownTrackId))) {
				bad('not one of your own tracks');
				break;
			}
			if (kind !== 'catalog' && kind !== 'own' && kind !== 'id') {
				bad('link a track or mark it as ID');
				break;
			}
			if (!t && kind !== 'id') {
				bad('needs a title');
				break;
			}
			tracklist.push({
				startMs: startMs === null ? null : Math.round(startMs),
				kind,
				trackUri: kind === 'catalog' ? (x.trackUri as string) : null,
				ownTrackId: kind === 'own' ? (x.ownTrackId as string) : null,
				artist: str(x.artist),
				title: t ?? 'ID'
			});
		}
	if (Object.keys(e).length) return { ok: false, errors: e };
	return {
		ok: true,
		value: { title: title!, event, date, durationMs: durationMs!, coverUrl, coverObjectId, source: source!, youtubeId: source === 'youtube' ? yt : null, soundcloudUrl: source === 'soundcloud' ? sc : null, audioObjectId: source === 'upload' ? audio : null, artists, tracklist }
	};
}
