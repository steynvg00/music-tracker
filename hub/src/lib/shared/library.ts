/** Library chips, sorting and grouping (03-ux-ia.md §3). Pure; used by the page and the sidebar. */
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
}

export const CHIPS = ['managed', 'snapshots', 'custom', 'yours', 'followed', 'liked'] as const;
export type Chip = (typeof CHIPS)[number];
export const CHIP_LABEL: Record<Chip, string> = {
	managed: 'Managed 🔄',
	snapshots: 'Snapshots 📸',
	custom: 'Custom 🎧',
	yours: 'Yours',
	followed: 'Followed',
	liked: 'Liked Songs'
};

export const SORTS = ['recent', 'rotation', 'az', 'tracks'] as const;
export type LibrarySort = (typeof SORTS)[number];
export const SORT_LABEL: Record<LibrarySort, string> = {
	recent: 'Recently played in Rotor',
	rotation: 'Rotation score',
	az: 'A–Z',
	tracks: 'Track count'
};

export function chipOf(r: LibraryRow): Exclude<Chip, 'liked'> {
	if (r.kind === 'auto_updating') return 'managed';
	if (r.kind === 'auto_snapshot') return 'snapshots';
	if (r.kind === 'custom') return 'custom';
	return r.isOwned || r.isCollab ? 'yours' : 'followed';
}

/** No chip selected = everything. 'liked' is a virtual row handled by the page. */
export function filterRows(rows: LibraryRow[], chips: ReadonlySet<Chip>): LibraryRow[] {
	const real = [...chips].filter((c) => c !== 'liked');
	if (!real.length) return chips.has('liked') ? [] : rows;
	return rows.filter((r) => chips.has(chipOf(r)));
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function sortRows(rows: LibraryRow[], sort: LibrarySort): LibraryRow[] {
	const out = [...rows];
	const byName = (a: LibraryRow, b: LibraryRow) => collator.compare(a.name, b.name);
	switch (sort) {
		case 'az':
			return out.sort(byName);
		case 'tracks':
			return out.sort((a, b) => (b.trackCount ?? -1) - (a.trackCount ?? -1) || byName(a, b));
		case 'rotation':
			return out.sort((a, b) => (b.rotationScore ?? -1) - (a.rotationScore ?? -1) || byName(a, b));
		case 'recent':
			return out.sort((a, b) => (b.lastPlayedOn ?? '').localeCompare(a.lastPlayedOn ?? '') || byName(a, b));
	}
}

export interface Group {
	key: string;
	name: string;
	rows: LibraryRow[];
}

/** Managed playlists grouped by rule category, in the catalog's order; the rest last. */
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
