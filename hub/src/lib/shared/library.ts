/**
 * Library: kinds, sorting, grouping and (v0.91) the Rotor-only organiser: pins, folders and a custom
 * order (migration 0034). Pure; used by the page, the sidebar, the server and the tests.
 *
 * Pins, folders and the custom order live in Rotor only: nothing here changes Spotify.
 */
import type { ManagedKind } from './managed';

export interface LibraryRow {
	id: string;
	uri: string;
	name: string;
	imageUrl: string | null;
	kind: ManagedKind | null;
	isOwned: boolean;
	isCollab: boolean;
	ownerName: string | null;
	trackCount: number | null;
	category: string | null;
	expiresAt: string | null;
	lastPlayedOn: string | null;
	rotationScore: number | null;
	/** When the playlist first appeared in the mirror ("Recently added"). */
	addedAt: string | null;
}

// ── Kinds (the pill bar) ─────────────────────────────────────────────────────

export const KINDS = ['managed', 'snapshots', 'custom', 'rules', 'followed', 'pinned', 'folders'] as const;
export type LibKind = (typeof KINDS)[number];
export const KIND_LABEL: Record<LibKind, string> = {
	managed: 'Managed 🔄',
	snapshots: 'Snapshots 📸',
	custom: 'Custom 🎧',
	rules: 'Rules-based',
	followed: 'Followed',
	pinned: 'Pinned',
	folders: 'Folders'
};

export type LibSource = 'spotify' | 'youtube' | 'soundcloud';
export const LIB_SOURCES: { key: LibSource; label: string }[] = [
	{ key: 'spotify', label: 'Spotify' },
	{ key: 'youtube', label: 'YouTube' },
	{ key: 'soundcloud', label: 'SoundCloud' }
];

/** Does a playlist belong to a playlist kind? (pinned / folders are organiser views, see libraryView) */
export function rowIsKind(r: LibraryRow, k: LibKind): boolean {
	switch (k) {
		case 'managed':
			return r.kind === 'auto_updating';
		case 'snapshots':
			return r.kind === 'auto_snapshot';
		case 'custom':
			return r.kind === 'custom';
		case 'rules':
			return !!r.category;
		case 'followed':
			return !r.kind && !r.isOwned && !r.isCollab;
		default:
			return false;
	}
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export const SORTS = ['az', 'recent', 'added', 'tracks', 'custom'] as const;
export type LibrarySort = (typeof SORTS)[number];
export const SORT_LABEL: Record<LibrarySort, string> = {
	az: 'A–Z',
	recent: 'Recently played',
	added: 'Recently added',
	tracks: 'Track count',
	custom: 'Custom order'
};
export type LibView = 'list' | 'grid';

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
export const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

export function sortRows(rows: LibraryRow[], sort: LibrarySort, position: (r: LibraryRow) => number = () => 0): LibraryRow[] {
	const out = [...rows];
	switch (sort) {
		case 'az':
			return out.sort(byName);
		case 'tracks':
			return out.sort((a, b) => (b.trackCount ?? -1) - (a.trackCount ?? -1) || byName(a, b));
		case 'recent':
			return out.sort((a, b) => (b.lastPlayedOn ?? '').localeCompare(a.lastPlayedOn ?? '') || byName(a, b));
		case 'added':
			return out.sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '') || byName(a, b));
		case 'custom':
			return out.sort((a, b) => position(a) - position(b) || byName(a, b));
	}
}

export interface Group {
	key: string;
	name: string;
	rows: LibraryRow[];
}

/** Rules-based playlists grouped by rule category, in the catalog's order; the rest last. */
export function groupByCategory(rows: LibraryRow[], categories: { key: string; name: string }[]): Group[] {
	const groups: Group[] = categories.map((c) => ({ key: c.key, name: c.name, rows: [] }));
	const byKey = new Map(groups.map((g) => [g.key, g]));
	const other: Group = { key: 'other', name: 'Not in a rule category yet', rows: [] };
	for (const r of rows) (r.category ? (byKey.get(r.category) ?? other) : other).rows.push(r);
	return [...groups, other].filter((g) => g.rows.length);
}

/** Playlists that may show edit affordances (the server's write guard decides for real). */
export function editable(r: Pick<LibraryRow, 'kind' | 'isOwned'>): boolean {
	return !!r.kind && r.isOwned;
}

// ── Organiser (0034): pins, folders, custom order ────────────────────────────

export const LIKED_KEY = 'rotor:liked';
export const playlistKey = (id: string) => `spotify:playlist:${id}`;
export const collectionKey = (id: string) => `rotor:collection:${id}`;
export const ITEM_KEY = /^(spotify:playlist:[A-Za-z0-9]{22}|rotor:liked|rotor:collection:[0-9a-f-]{36})$/;
export const MAX_FOLDER_NAME = 100;

export interface LibFolder {
	id: number;
	name: string;
	parentId: number | null;
	position: number;
	pinPos: number | null;
}
export interface LibItem {
	key: string;
	folderId: number | null;
	position: number;
	pinPos: number | null;
}
export interface Organiser {
	folders: LibFolder[];
	items: LibItem[];
}
export const EMPTY_ORGANISER: Organiser = { folders: [], items: [] };

/** A pin target: an item key, or "folder:<id>". */
export const folderTarget = (id: number) => `folder:${id}`;

export type Entry =
	| { type: 'playlist'; key: string; row: LibraryRow; pinned: boolean; folderId: number | null }
	| { type: 'liked'; key: string; pinned: boolean; folderId: number | null }
	| { type: 'folder'; key: string; folder: LibFolder; pinned: boolean; count: number; children: number };

export interface ViewInput {
	rows: LibraryRow[];
	org: Organiser;
	kind: LibKind | null;
	sort: LibrarySort;
	/** Inside a folder (null = the Library root). */
	folderId: number | null;
	/** Filter-as-you-type over names (searches inside folders too). */
	q: string;
	categories?: { key: string; name: string }[];
}

export interface LibraryViewModel {
	/** Pinned folders + playlists in your order (root view only). */
	pinned: Entry[];
	entries: Entry[];
	/** Rules-based: grouped by rule category. */
	groups: Group[] | null;
	folder: LibFolder | null;
	parent: LibFolder | null;
}

const LIKED_NAME = 'Liked Songs';

export function libraryView(v: ViewInput): LibraryViewModel {
	const item = new Map(v.org.items.map((i) => [i.key, i]));
	const folders = v.org.folders;
	const folderById = new Map(folders.map((f) => [f.id, f]));
	const q = v.q.trim().toLowerCase();
	const matches = (name: string) => !q || name.toLowerCase().includes(q);
	const pos = (key: string) => item.get(key)?.position ?? Number.MAX_SAFE_INTEGER;
	const folderOf = (key: string): number | null => {
		const f = item.get(key)?.folderId ?? null;
		return f !== null && folderById.has(f) ? f : null; // a deleted folder's items are back at the root
	};
	const pinOf = (key: string) => item.get(key)?.pinPos ?? null;
	const countIn = (fid: number) => v.rows.filter((r) => folderOf(playlistKey(r.id)) === fid).length + (folderOf(LIKED_KEY) === fid ? 1 : 0);
	const childrenOf = (fid: number) => folders.filter((f) => f.parentId === fid);
	const folderEntry = (f: LibFolder): Entry => ({
		type: 'folder',
		key: folderTarget(f.id),
		folder: f,
		pinned: f.pinPos !== null,
		count: countIn(f.id) + childrenOf(f.id).reduce((n, c) => n + countIn(c.id), 0),
		children: childrenOf(f.id).length
	});
	const rowEntry = (r: LibraryRow): Entry => {
		const key = playlistKey(r.id);
		return { type: 'playlist', key, row: r, pinned: pinOf(key) !== null, folderId: folderOf(key) };
	};
	const likedEntry = (): Entry => ({ type: 'liked', key: LIKED_KEY, pinned: pinOf(LIKED_KEY) !== null, folderId: folderOf(LIKED_KEY) });
	const sortFolders = (list: LibFolder[]) => [...list].sort(v.sort === 'custom' ? (a, b) => a.position - b.position || byName(a, b) : byName);
	const sorted = (rows: LibraryRow[]) => sortRows(rows, v.sort, (r) => pos(playlistKey(r.id)));
	const empty: LibraryViewModel = { pinned: [], entries: [], groups: null, folder: null, parent: null };

	// Search: every match, wherever it is (folders included), flat.
	if (q) {
		const fs = sortFolders(folders.filter((f) => matches(f.name))).map(folderEntry);
		const ps = sorted(v.rows.filter((r) => matches(r.name) && (!v.kind || rowIsKind(r, v.kind) || v.kind === 'pinned' || v.kind === 'folders')));
		const liked = matches(LIKED_NAME) && (!v.kind || v.kind === 'pinned') ? [likedEntry()] : [];
		let entries = [...(v.kind === 'folders' || !v.kind || v.kind === 'pinned' ? fs : []), ...liked, ...(v.kind === 'folders' ? [] : ps.map(rowEntry))];
		if (v.kind === 'pinned') entries = entries.filter((e) => e.pinned);
		return { ...empty, entries };
	}

	if (v.kind === 'pinned') return { ...empty, entries: pinnedEntries() };
	if (v.kind === 'folders') {
		const top = sortFolders(folders.filter((f) => f.parentId === null || !folderById.has(f.parentId)));
		return { ...empty, entries: top.flatMap((f) => [folderEntry(f), ...sortFolders(childrenOf(f.id)).map(folderEntry)]) };
	}
	if (v.kind === 'rules') {
		const rows = sorted(v.rows.filter((r) => rowIsKind(r, 'rules')));
		return { ...empty, entries: rows.map(rowEntry), groups: groupByCategory(rows, v.categories ?? []) };
	}
	if (v.kind) return { ...empty, entries: sorted(v.rows.filter((r) => rowIsKind(r, v.kind!))).map(rowEntry) };

	// Inside a folder: its subfolders, then its playlists (pinned ones too, marked).
	if (v.folderId !== null) {
		const f = folderById.get(v.folderId) ?? null;
		if (!f) return empty;
		const subs = sortFolders(childrenOf(f.id)).map(folderEntry);
		const liked = folderOf(LIKED_KEY) === f.id ? [likedEntry()] : [];
		const rows = sorted(v.rows.filter((r) => folderOf(playlistKey(r.id)) === f.id)).map(rowEntry);
		return { ...empty, folder: f, parent: f.parentId !== null ? (folderById.get(f.parentId) ?? null) : null, entries: [...subs, ...liked, ...rows] };
	}

	// The root: pinned first (your order), then folders, Liked Songs and playlists not in a folder.
	const pinned = pinnedEntries();
	const top = sortFolders(folders.filter((f) => (f.parentId === null || !folderById.has(f.parentId)) && f.pinPos === null)).map(folderEntry);
	const liked = folderOf(LIKED_KEY) === null && pinOf(LIKED_KEY) === null ? [likedEntry()] : [];
	const rows = sorted(v.rows.filter((r) => folderOf(playlistKey(r.id)) === null && pinOf(playlistKey(r.id)) === null)).map(rowEntry);
	return { ...empty, pinned, entries: [...top, ...liked, ...rows] };

	function pinnedEntries(): Entry[] {
		const list: { pin: number; e: Entry }[] = [];
		for (const f of folders) if (f.pinPos !== null) list.push({ pin: f.pinPos, e: folderEntry(f) });
		for (const r of v.rows) {
			const p = pinOf(playlistKey(r.id));
			if (p !== null) list.push({ pin: p, e: rowEntry(r) });
		}
		const lp = pinOf(LIKED_KEY);
		if (lp !== null) list.push({ pin: lp, e: likedEntry() });
		return list.sort((a, b) => a.pin - b.pin).map((x) => x.e);
	}
}

/** Folders a selection may move into: every folder (top-level and one level down). */
export function moveTargets(org: Organiser): { id: number; name: string; depth: 0 | 1 }[] {
	const top = [...org.folders].filter((f) => f.parentId === null).sort(byName);
	return top.flatMap((f) => [
		{ id: f.id, name: f.name, depth: 0 as const },
		...org.folders
			.filter((c) => c.parentId === f.id)
			.sort(byName)
			.map((c) => ({ id: c.id, name: c.name, depth: 1 as const }))
	]);
}

/** Move one entry in a list of keys (drag to reorder): returns the new order. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
	const out = [...list];
	if (from < 0 || from >= out.length) return out;
	const [x] = out.splice(from, 1);
	out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
	return out;
}
