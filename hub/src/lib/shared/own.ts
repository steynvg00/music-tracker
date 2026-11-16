/**
 * Own tracks (v0.94): unreleased songs and IDs you keep in Rotor, with complete metadata. Pure: the
 * form validates with exactly the same rules as the server (and migration 0036's CHECKs back them up).
 *
 * Nothing here is ever written to a Spotify playlist; own tracks play in Rotor's own player only.
 */

export const OWN_STATUS = ['unreleased', 'id', 'released_elsewhere'] as const;
export type OwnStatus = (typeof OWN_STATUS)[number];
export const STATUS_LABEL: Record<OwnStatus, string> = { unreleased: 'Unreleased', id: 'ID', released_elsewhere: 'Released elsewhere' };

export const ROLES = ['primary', 'featuring', 'remixer', 'producer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { primary: 'Artist', featuring: 'Featuring', remixer: 'Remixer', producer: 'Producer' };

export const VERSIONS = ['Original Mix', 'Extended Mix', 'Radio Edit', 'Club Mix', 'Remix', 'VIP', 'Edit', 'Bootleg', 'Live', 'Acapella', 'Instrumental'];

/** An artist link: one from your Spotify history, or a Rotor artist you created explicitly. */
export interface ArtistLink {
	kind: 'spotify' | 'rotor';
	id: string;
	name: string;
}

export interface OwnTrackInput {
	title: string;
	version: string | null;
	status: OwnStatus | null;
	durationMs: number | null;
	artists: Record<Role, ArtistLink[]>;
	label: string | null;
	dateKind: 'release' | 'first_heard' | null;
	date: string | null;
	heardSetId: string | null;
	heardAtMs: number | null;
	heardNote: string | null;
	notes: string | null;
	coverUrl: string | null;
	coverObjectId: string | null;
	youtubeUrl: string | null;
	soundcloudUrl: string | null;
	audioObjectId: string | null;
}

export const emptyInput = (): OwnTrackInput => ({
	title: '',
	version: null,
	status: null,
	durationMs: null,
	artists: { primary: [], featuring: [], remixer: [], producer: [] },
	label: null,
	dateKind: null,
	date: null,
	heardSetId: null,
	heardAtMs: null,
	heardNote: null,
	notes: null,
	coverUrl: null,
	coverObjectId: null,
	youtubeUrl: null,
	soundcloudUrl: null,
	audioObjectId: null
});

export interface OwnTrack {
	id: string;
	title: string;
	version: string | null;
	status: OwnStatus;
	durationMs: number;
	artists: Record<Role, ArtistLink[]>;
	label: string | null;
	dateKind: 'release' | 'first_heard' | null;
	date: string | null;
	heardSet: { id: string; title: string } | null;
	heardAtMs: number | null;
	heardNote: string | null;
	notes: string | null;
	cover: string | null;
	coverUrl: string | null;
	coverObjectId: string | null;
	youtubeId: string | null;
	soundcloudUrl: string | null;
	audio: { id: string; contentType: string; size: number; name: string | null } | null;
	plays: number;
	lastPlayedAt: string | null;
	createdAt: string;
}

// ── placeholders (mirror of rotor_is_placeholder() in 0036) ──────────────────

const PLACEHOLDERS = new Set([
	'unknown', 'unknown artist', 'unknown title', 'unknown track', '?', '??', '???', '-', '--', '—',
	'n/a', 'na', 'none', 'null', 'tba', 'tbc', 'tbd', 'untitled', 'no title', 'id', 'id - id', 'id-id',
	'id – id', 'id — id', 'unreleased', 'xxx', '...', '…'
]);
export function isPlaceholder(v: string | null | undefined): boolean {
	if (v === null || v === undefined) return true;
	const t = v.trim();
	if (!t) return true;
	if (PLACEHOLDERS.has(t.replace(/\s+/g, ' ').toLowerCase())) return true;
	return /^[?.\-–—_*\s]+$/.test(t);
}

// ── durations ────────────────────────────────────────────────────────────────

/** "3:45", "1:02:03", "225" (seconds) → ms; null when it isn't a duration. */
export function parseDuration(v: string | number | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
	const s = v.trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) return Number(s) * 1000;
	const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(s);
	if (!m) return null;
	const sec = Number(m[3]);
	if (sec > 59) return null;
	return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + sec) * 1000;
}
export function fmtClock(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// ── links ────────────────────────────────────────────────────────────────────

const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;
export function youtubeId(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw.trim());
		const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
		let v: string | null = null;
		if (host === 'youtu.be') v = u.pathname.slice(1).split('/')[0] ?? null;
		else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
			if (u.pathname === '/watch') v = u.searchParams.get('v');
			else {
				const m = /^\/(embed|live|shorts|v)\/([^/]+)/.exec(u.pathname);
				v = m ? m[2]! : null;
			}
		}
		return v && YT_VIDEO.test(v) ? v : null;
	} catch {
		return null;
	}
}
/** A SoundCloud track or set link, normalised (no query, https://soundcloud.com/...). */
export function soundcloudUrl(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw.trim());
		if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(u.hostname.toLowerCase())) return null;
		const parts = u.pathname.split('/').filter(Boolean);
		if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^[A-Za-z0-9_-]{1,100}$/.test(p))) return null;
		if (['likes', 'followers', 'following', 'reposts', 'tracks', 'albums'].includes(parts[1]!) && parts.length === 2) return null;
		return `https://soundcloud.com/${parts.join('/')}`;
	} catch {
		return null;
	}
}

// ── validation ───────────────────────────────────────────────────────────────

export type Errors = Partial<Record<'title' | 'version' | 'status' | 'duration' | 'artists' | 'label' | 'date' | 'heard' | 'notes' | 'cover' | 'source' | 'youtube' | 'soundcloud', string>>;

export interface CleanOwnTrack {
	title: string;
	version: string | null;
	status: OwnStatus;
	durationMs: number;
	artists: Record<Role, ArtistLink[]>;
	label: string | null;
	dateKind: 'release' | 'first_heard' | null;
	date: string | null;
	heardSetId: string | null;
	heardAtMs: number | null;
	heardNote: string | null;
	notes: string | null;
	coverUrl: string | null;
	coverObjectId: string | null;
	youtubeId: string | null;
	soundcloudUrl: string | null;
	audioObjectId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function cleanLinks(v: unknown): ArtistLink[] | null {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.length > 10) return null;
	const out: ArtistLink[] = [];
	for (const a of v) {
		if (!a || typeof a !== 'object') return null;
		const { kind, id, name } = a as Record<string, unknown>;
		if (kind === 'spotify' && typeof id === 'string' && SPOTIFY_ID.test(id) && typeof name === 'string' && !isPlaceholder(name)) out.push({ kind, id, name: name.trim() });
		else if (kind === 'rotor' && typeof id === 'string' && UUID.test(id) && typeof name === 'string' && !isPlaceholder(name)) out.push({ kind, id, name: name.trim() });
		else return null;
	}
	return out;
}

/** Same rules client and server side. A missing or placeholder value is an error, never a default. */
export function validateOwnTrack(raw: unknown): { ok: true; value: CleanOwnTrack } | { ok: false; errors: Errors } {
	const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const e: Errors = {};
	const title = str(b.title);
	if (!title) e.title = 'Title is required';
	else if (isPlaceholder(title)) e.title = `“${title}” is a placeholder, not a title`;
	else if (title.length > 200) e.title = 'At most 200 characters';
	const version = str(b.version);
	if (version && (isPlaceholder(version) || version.length > 100)) e.version = 'Pick a real version (e.g. Extended Mix) or leave it empty';
	const status = OWN_STATUS.includes(b.status as OwnStatus) ? (b.status as OwnStatus) : null;
	if (!status) e.status = 'Pick a status';
	const durationMs = typeof b.durationMs === 'number' ? parseDuration(b.durationMs) : parseDuration(b.durationMs as string | null);
	if (!durationMs) e.duration = 'Duration is required (m:ss)';
	else if (durationMs < 1000 || durationMs > 7_200_000) e.duration = 'Between 0:01 and 2:00:00';
	const ar = (b.artists && typeof b.artists === 'object' ? b.artists : {}) as Record<string, unknown>;
	const artists = { primary: cleanLinks(ar.primary), featuring: cleanLinks(ar.featuring), remixer: cleanLinks(ar.remixer), producer: cleanLinks(ar.producer) };
	if (Object.values(artists).some((x) => x === null)) e.artists = 'Every artist must be linked to an artist in your data, or created explicitly';
	else if (!artists.primary!.length) e.artists = 'At least one artist is required';
	const label = str(b.label);
	if (label && (isPlaceholder(label) || label.length > 200)) e.label = 'Enter the real label or leave it empty';
	const date = str(b.date);
	const dateKind = b.dateKind === 'release' || b.dateKind === 'first_heard' ? b.dateKind : null;
	if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) e.date = 'Use a full date';
	else if (date && !dateKind) e.date = 'Release date or first heard?';
	const heardSetId = str(b.heardSetId);
	if (heardSetId && !UUID.test(heardSetId)) e.heard = 'Unknown set';
	const heardAt = b.heardAtMs === null || b.heardAtMs === undefined || b.heardAtMs === '' ? null : typeof b.heardAtMs === 'number' ? b.heardAtMs : parseDuration(String(b.heardAtMs));
	if (heardAt !== null && (!Number.isFinite(heardAt) || heardAt < 0)) e.heard = 'Timestamp as m:ss or h:mm:ss';
	if (heardAt !== null && !heardSetId) e.heard = 'A timestamp needs the set you heard it in';
	const heardNote = str(b.heardNote);
	if (heardNote && heardNote.length > 300) e.heard = 'At most 300 characters';
	const notes = str(b.notes);
	if (notes && notes.length > 4000) e.notes = 'At most 4000 characters';
	const coverUrl = str(b.coverUrl);
	if (coverUrl && !/^https:\/\/[^\s]+$/.test(coverUrl)) e.cover = 'Cover link must start with https://';
	const coverObjectId = str(b.coverObjectId);
	if (coverObjectId && !UUID.test(coverObjectId)) e.cover = 'Unknown cover file';
	const ytRaw = str(b.youtubeUrl);
	const yt = youtubeId(ytRaw);
	if (ytRaw && !yt) e.youtube = 'Not a YouTube video link';
	const scRaw = str(b.soundcloudUrl);
	const sc = soundcloudUrl(scRaw);
	if (scRaw && !sc) e.soundcloud = 'Not a SoundCloud track link';
	const audioObjectId = str(b.audioObjectId);
	if (audioObjectId && !UUID.test(audioObjectId)) e.source = 'Unknown audio file';
	if (!yt && !sc && !audioObjectId && !e.youtube && !e.soundcloud) e.source = 'Add at least one source: a YouTube link, a SoundCloud link or an audio file';
	if (Object.keys(e).length) return { ok: false, errors: e };
	return {
		ok: true,
		value: {
			title: title!,
			version,
			status: status!,
			durationMs: durationMs!,
			artists: artists as Record<Role, ArtistLink[]>,
			label,
			dateKind: date ? dateKind : null,
			date,
			heardSetId,
			heardAtMs: heardAt,
			heardNote,
			notes,
			coverUrl,
			coverObjectId,
			youtubeId: yt,
			soundcloudUrl: sc,
			audioObjectId
		}
	};
}

// ── duplicates ───────────────────────────────────────────────────────────────

/** Lower-case, accents off, "(Extended Mix)"/"feat. X" stripped, punctuation to spaces. */
export function normTitle(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/\s*[([][^)\]]*(mix|edit|remix|version|vip|bootleg|rework|dub|live|instrumental|acapella)[^)\]]*[)\]]/g, ' ')
		.replace(/\s*[([]\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/g, ' ')
		.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}
export function normArtist(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/^the\s+/, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}
export function normVersion(s: string | null): string {
	const v = (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	return v === 'original mix' || v === 'original' ? '' : v;
}
/** "artist a+artist b|title|version" — the 0036 dupe_key. */
export function dupeKey(primaryNames: string[], title: string, version: string | null): string {
	return `${[...new Set(primaryNames.map(normArtist))].sort().join('+')}|${normTitle(title)}|${normVersion(version)}`;
}

export interface DuplicateMatch {
	kind: 'own' | 'catalog';
	id: string;
	title: string;
	artist: string;
	/** exact = same artists, title and version; similar = same title with an overlapping artist. */
	strength: 'exact' | 'similar';
	href: string;
}

/** Same title (normalised) and at least one primary artist in common. */
export function similar(a: { title: string; artists: string[] }, b: { title: string; artists: string[] }): boolean {
	if (normTitle(a.title) !== normTitle(b.title) || !normTitle(a.title)) return false;
	const x = new Set(a.artists.map(normArtist));
	return b.artists.some((n) => x.has(normArtist(n)));
}

// ── "Artist - Title (Extended Mix)" from an embed title ──────────────────────

export interface ParsedTitle {
	artists: string[];
	featuring: string[];
	title: string;
	version: string | null;
	remixer: string | null;
}
const SPLIT_ARTISTS = /\s*(?:,|&|\bx\b|\band\b|\bvs\.?\b)\s*/i;
export function parseEmbedTitle(raw: string, uploader: string | null = null): ParsedTitle {
	let s = raw
		.replace(/\s*[[(](official\s+)?(music\s+)?(video|audio|visualiser|visualizer|lyric video|lyrics|hq|hd|4k|free download|out now)[^)\]]*[)\]]/gi, '')
		.replace(/\s*\|.*$/, '')
		.trim();
	let artistPart = '';
	const dash = /\s+[-–—]\s+/.exec(s);
	if (dash) {
		artistPart = s.slice(0, dash.index);
		s = s.slice(dash.index + dash[0].length);
	} else if (uploader) {
		artistPart = uploader.replace(/\s*-\s*topic$/i, '');
	}
	let version: string | null = null;
	let remixer: string | null = null;
	const vm = /\s*[([]([^)\]]*(?:mix|edit|remix|version|vip|bootleg|rework|dub|live)[^)\]]*)[)\]]\s*$/i.exec(s);
	if (vm) {
		version = vm[1]!.trim();
		s = s.slice(0, vm.index).trim();
		const rm = /^(.+?)\s+(remix|rework|bootleg|edit|vip)$/i.exec(version);
		if (rm && !/^(extended|radio|club|original|short)$/i.test(rm[1]!)) remixer = rm[1]!.trim();
	}
	const featuring: string[] = [];
	const ft = /\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]?/i;
	for (const part of ['artist', 'title'] as const) {
		const src = part === 'artist' ? artistPart : s;
		const m = ft.exec(src);
		if (m) {
			featuring.push(...m[1]!.split(SPLIT_ARTISTS).map((x) => x.trim()).filter(Boolean));
			if (part === 'artist') artistPart = src.slice(0, m.index).trim();
			else s = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();
		}
	}
	const artists = artistPart
		.split(SPLIT_ARTISTS)
		.map((x) => x.trim())
		.filter((x) => x && !isPlaceholder(x));
	return { artists, featuring, title: s.trim(), version, remixer };
}

/** Library / organiser keys. */
export const ownKey = (id: string) => `rotor:own:${id}`;
export const listKey = (id: string) => `rotor:list:${id}`;
export const setKey = (id: string) => `rotor:set:${id}`;
export const artistLine = (links: ArtistLink[]) => links.map((a) => a.name).join(', ');
export function displayTitle(t: { title: string; version: string | null }): string {
	return t.version ? `${t.title} (${t.version})` : t.title;
}

/** A Rotor-only list of own tracks (never a Spotify playlist). */
export interface RotorList {
	id: string;
	name: string;
	count: number;
	durationMs: number;
	updatedAt: string;
}
