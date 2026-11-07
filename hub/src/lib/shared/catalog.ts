/**
 * Artist pages (beta) + Spotify catalog search (v0.90): types and pure rules shared by the server,
 * the pages and the tests. Built against the Feb 2026 Development Mode endpoint set:
 * GET /artists/{id}, /artists/{id}/albums (one include_groups value per request, so the group is
 * known), /albums/{id}, /albums/{id}/tracks and /search (limit ≤ 10). Album objects have no
 * album_group, label or popularity any more; artists have no followers/popularity.
 */

export const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

export type ReleaseGroup = 'album' | 'single' | 'compilation' | 'appears_on';
export const RELEASE_GROUPS: ReleaseGroup[] = ['album', 'single', 'compilation', 'appears_on'];
export const GROUP_LABEL: Record<ReleaseGroup, string> = {
	album: 'Albums',
	single: 'Singles & EPs',
	compilation: 'Compilations',
	appears_on: 'Appears on'
};
export type ReleaseType = 'album' | 'single' | 'compilation';
export type DatePrecision = 'year' | 'month' | 'day';

export interface Release {
	id: string;
	name: string;
	date: string | null;
	precision: DatePrecision | null;
	group: ReleaseGroup;
	type: ReleaseType | null;
	cover: string | null;
	total: number;
}

/** Your own data about a release or a track (never from Spotify). */
export type MyState = 'liked' | 'played' | 'not_heard';
export const STATE_LABEL: Record<MyState, string> = { liked: 'Liked', played: 'Played', not_heard: 'Not heard' };

export interface CatalogTrack {
	id: string;
	uri: string;
	name: string;
	number: number;
	disc: number;
	durationMs: number;
	artists: { id: string | null; name: string }[];
	plays: number;
	liked: boolean;
}

export interface ReleaseWithState extends Release {
	plays: number;
	liked: boolean;
	state: MyState;
}

export interface ArtistMine {
	plays: number;
	hours: number;
	tracks: number;
	firstPlayedAt: string | null;
	lastPlayedAt: string | null;
	badges: { type: string; label: string; emoji: string; awardedAt: string }[];
}

export interface ArtistPage {
	artist: { id: string; name: string; image: string | null };
	mine: ArtistMine;
	releases: ReleaseWithState[];
	cache: { hit: boolean; stale: boolean; fetchedAt: string };
}

export interface CatalogAlbum {
	id: string;
	name: string;
	type: ReleaseType | null;
	date: string | null;
	precision: DatePrecision | null;
	cover: string | null;
	total: number;
	artists: { id: string | null; name: string }[];
	tracks: CatalogTrack[];
	plays: number;
	liked: boolean;
	state: MyState;
}

export type SearchType = 'artist' | 'album' | 'track';
export const SEARCH_TYPES: SearchType[] = ['artist', 'album', 'track'];
/** Spotify caps search at 10 per request since Feb 2026: "load more" pages in steps of 10. */
export const SEARCH_PAGE = 10;

export interface CatalogSearchPage<T> {
	items: T[];
	total: number;
	offset: number;
	next: number | null;
}
export interface CatalogSearchResults {
	q: string;
	artists?: CatalogSearchPage<{ id: string; name: string; image: string | null }>;
	albums?: CatalogSearchPage<{ id: string; name: string; date: string | null; type: ReleaseType | null; cover: string | null; artists: { id: string | null; name: string }[] }>;
	tracks?: CatalogSearchPage<CatalogTrack & { album: { id: string | null; name: string } }>;
}

// ── Storage encoding (migration 0031) ────────────────────────────────────────

const COVER_PREFIX = 'https://i.scdn.co/image/';

/** Spotify image URLs share a fixed prefix; store only the rest. Anything else is kept whole. */
export function shortCover(url: string | null | undefined): string | null {
	if (!url) return null;
	return url.startsWith(COVER_PREFIX) ? url.slice(COVER_PREFIX.length) : url;
}
export function longCover(v: string | null | undefined): string | null {
	if (!v) return null;
	return v.includes('://') ? v : COVER_PREFIX + v;
}

const G2C: Record<ReleaseGroup, string> = { album: 'a', single: 's', compilation: 'c', appears_on: 'p' };
const C2G: Record<string, ReleaseGroup> = { a: 'album', s: 'single', c: 'compilation', p: 'appears_on' };
const T2C: Record<ReleaseType, string> = { album: 'a', single: 's', compilation: 'c' };
const C2T: Record<string, ReleaseType> = { a: 'album', s: 'single', c: 'compilation' };
const P2C: Record<DatePrecision, string> = { year: 'y', month: 'm', day: 'd' };
const C2P: Record<string, DatePrecision> = { y: 'year', m: 'month', d: 'day' };

export type PackedRelease = [string, string, string | null, string | null, string, string | null, string | null, number];
export type PackedTrack = [string, string, number, number];

export function packRelease(r: Release): PackedRelease {
	return [r.id, r.name, r.date, r.precision ? P2C[r.precision] : null, G2C[r.group], r.type ? T2C[r.type] : null, shortCover(r.cover), r.total];
}
export function unpackRelease(p: PackedRelease): Release {
	return {
		id: p[0],
		name: p[1],
		date: p[2],
		precision: p[3] ? (C2P[p[3]] ?? null) : null,
		group: C2G[p[4]] ?? 'album',
		type: p[5] ? (C2T[p[5]] ?? null) : null,
		cover: longCover(p[6]),
		total: p[7]
	};
}

// ── Spotify objects → ours ───────────────────────────────────────────────────

export interface SpImage {
	url: string;
	width?: number | null;
	height?: number | null;
}
export interface SpArtistRef {
	id: string | null;
	name: string;
}
export interface SpAlbum {
	id: string;
	name: string;
	album_type?: string;
	total_tracks?: number;
	release_date?: string | null;
	release_date_precision?: string | null;
	images?: SpImage[];
	artists?: SpArtistRef[];
}
export interface SpTrack {
	id: string;
	uri?: string;
	name: string;
	track_number?: number;
	disc_number?: number;
	duration_ms?: number;
	artists?: SpArtistRef[];
	album?: SpAlbum;
}

/** One cover size: the one closest to 300 px (Spotify sends 640 / 300 / 64). */
export function pickImage(images: SpImage[] | undefined, target = 300): string | null {
	if (!images?.length) return null;
	const scored = images.map((i) => ({ url: i.url, d: Math.abs((i.width ?? target) - target) }));
	scored.sort((a, b) => a.d - b.d);
	return scored[0]!.url;
}

const asType = (t: string | undefined): ReleaseType | null => (t === 'album' || t === 'single' || t === 'compilation' ? t : null);
const asPrecision = (p: string | null | undefined): DatePrecision | null => (p === 'year' || p === 'month' || p === 'day' ? p : null);

export function toRelease(a: SpAlbum, group: ReleaseGroup): Release {
	return {
		id: a.id,
		name: a.name,
		date: a.release_date || null,
		precision: asPrecision(a.release_date_precision),
		group,
		type: asType(a.album_type),
		cover: pickImage(a.images),
		total: a.total_tracks ?? 0
	};
}

export function toTrack(t: SpTrack, mine?: { plays: number; liked: boolean }): CatalogTrack {
	return {
		id: t.id,
		uri: t.uri ?? `spotify:track:${t.id}`,
		name: t.name,
		number: t.track_number ?? 0,
		disc: t.disc_number ?? 1,
		durationMs: t.duration_ms ?? 0,
		artists: (t.artists ?? []).map((a) => ({ id: a.id ?? null, name: a.name })),
		plays: mine?.plays ?? 0,
		liked: mine?.liked ?? false
	};
}

export function packOwnTrack(t: CatalogTrack): PackedTrack {
	return [t.id, t.name, t.number, t.durationMs];
}
export function unpackOwnTrack(p: PackedTrack, artist: { id: string; name: string }): CatalogTrack {
	return { id: p[0], uri: `spotify:track:${p[0]}`, name: p[1], number: p[2], disc: 1, durationMs: p[3], artists: [{ id: artist.id, name: artist.name }], plays: 0, liked: false };
}

/** "Appears on": only the tracks that credit this artist. */
export function ownTracks(tracks: SpTrack[], artistId: string): SpTrack[] {
	return tracks.filter((t) => (t.artists ?? []).some((a) => a.id === artistId));
}

// ── Sorting + grouping ───────────────────────────────────────────────────────

/** Sort key: "2015" → "2015-00-00", "2015-03" → "2015-03-00"; unknown dates sort last either way. */
export function dateKey(date: string | null): string {
	if (!date) return '';
	const [y = '0000', m = '00', d = '00'] = date.split('-');
	return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export type SortOrder = 'newest' | 'oldest';

export function sortReleases<T extends Release>(list: T[], order: SortOrder): T[] {
	return [...list].sort((a, b) => {
		const ka = dateKey(a.date);
		const kb = dateKey(b.date);
		if (!ka !== !kb) return ka ? -1 : 1; // undated last in both orders
		if (ka !== kb) return order === 'newest' ? (ka < kb ? 1 : -1) : ka < kb ? -1 : 1;
		return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
	});
}

export interface YearBlock<T> {
	year: string;
	items: T[];
}

/** Consecutive releases of one year under one header (input already sorted). */
export function byYear<T extends Release>(sorted: T[]): YearBlock<T>[] {
	const out: YearBlock<T>[] = [];
	for (const r of sorted) {
		const y = r.date?.slice(0, 4) || 'Unknown year';
		const last = out.at(-1);
		if (last && last.year === y) last.items.push(r);
		else out.push({ year: y, items: [r] });
	}
	return out;
}

export function myState(plays: number, liked: boolean): MyState {
	return liked ? 'liked' : plays > 0 ? 'played' : 'not_heard';
}

export const TYPE_LABEL: Record<ReleaseType, string> = { album: 'Album', single: 'Single', compilation: 'Compilation' };

/** Spotify calls a release with 4–6 tracks (or ≤ 30 min) an EP but still types it "single". */
export function typeLabel(r: { type: ReleaseType | null; total: number }): string {
	if (!r.type) return 'Release';
	if (r.type === 'single' && r.total >= 4) return 'EP';
	return TYPE_LABEL[r.type];
}

export function fmtReleaseDate(date: string | null, precision: DatePrecision | null): string {
	if (!date) return 'Unknown date';
	const p = precision ?? (date.length === 4 ? 'year' : date.length === 7 ? 'month' : 'day');
	if (p === 'year') return date.slice(0, 4);
	const [y, m, d] = date.split('-').map(Number);
	const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
	return p === 'month'
		? dt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
		: dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Where artist links go: the beta page with the flag on, else the R3 stats page. */
export function catalogArtistHref(id: string | null | undefined): string | null {
	return id && SPOTIFY_ID.test(id) ? `/catalog/artist/${id}` : null;
}
export function catalogAlbumHref(id: string | null | undefined): string | null {
	return id && SPOTIFY_ID.test(id) ? `/catalog/album/${id}` : null;
}
