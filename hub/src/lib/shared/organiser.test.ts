import { describe, expect, it } from 'vitest';
import { hasClearable, pick, visiblePills, type PillGroup } from './pills';
import { LIKED_KEY, libraryView, moveTargets, playlistKey, reorder, type LibraryRow, type Organiser } from './library';
import { itemKeys, pinTargets } from '$lib/server/organiser';

const id = (c: string) => c.repeat(22);
const row = (c: string, over: Partial<LibraryRow> = {}): LibraryRow => ({
	id: id(c),
	uri: `spotify:playlist:${id(c)}`,
	name: c.toUpperCase() + ' list',
	imageUrl: null,
	kind: null,
	isOwned: true,
	isCollab: false,
	ownerName: null,
	trackCount: 10,
	category: null,
	expiresAt: null,
	lastPlayedOn: null,
	rotationScore: null,
	addedAt: null,
	...over
});

describe('v0.91 pill bar rules', () => {
	const groups = (source: string | null, kind: string | null): PillGroup[] => [
		{ key: 'source', label: 'Source', collapse: true, value: source, options: [{ value: 'spotify', label: 'Spotify' }, { value: 'youtube', label: 'YouTube' }] },
		{ key: 'kind', label: 'Kind', collapse: true, hidden: source === 'youtube', value: kind, options: [{ value: 'managed', label: 'Managed' }, { value: 'custom', label: 'Custom' }] }
	];
	it('nothing selected: every option, no ×', () => {
		expect(visiblePills(groups(null, null)).map((p) => p.value)).toEqual(['spotify', 'youtube', 'managed', 'custom']);
		expect(hasClearable(groups(null, null))).toBe(false);
	});
	it('a selected pill moves first, its group collapses, × appears', () => {
		const v = visiblePills(groups(null, 'custom'));
		expect(v.map((p) => [p.value, p.active])).toEqual([['custom', true], ['spotify', false], ['youtube', false]]);
		expect(hasClearable(groups(null, 'custom'))).toBe(true);
	});
	it('a hidden group shows nothing (kinds while YouTube is the source)', () => {
		expect(visiblePills(groups('youtube', 'custom')).map((p) => p.value)).toEqual(['youtube']);
	});
	it('picking the selected pill clears it; required groups never clear', () => {
		const g = groups(null, 'custom')[1]!;
		expect(pick(g, 'custom')).toBeNull();
		expect(pick(g, 'managed')).toBe('managed');
		const req: PillGroup = { key: 'view', label: 'List', required: true, value: 'tracks', options: [{ value: 'tracks', label: 'Tracks' }, { value: 'artists', label: 'Artists' }] };
		expect(pick(req, 'tracks')).toBe('tracks');
		expect(hasClearable([req])).toBe(false);
		expect(visiblePills([req]).map((p) => [p.value, p.active])).toEqual([['tracks', true], ['artists', false]]);
	});
});

describe('v0.91 Library view: pins, folders, custom order, search', () => {
	const rows = [row('a', { kind: 'auto_updating', category: 'top' }), row('b', { kind: 'custom' }), row('c'), row('d', { isOwned: false }), row('e')];
	const org: Organiser = {
		folders: [
			{ id: 1, name: 'Gym', parentId: null, position: 1, pinPos: null },
			{ id: 2, name: 'Cardio', parentId: 1, position: 0, pinPos: null },
			{ id: 3, name: 'Archive', parentId: null, position: 0, pinPos: 0 }
		],
		items: [
			{ key: playlistKey(id('c')), folderId: 1, position: 0, pinPos: null },
			{ key: playlistKey(id('d')), folderId: 2, position: 0, pinPos: null },
			{ key: playlistKey(id('e')), folderId: null, position: 0, pinPos: 2 },
			{ key: LIKED_KEY, folderId: null, position: 0, pinPos: 1 },
			{ key: playlistKey(id('b')), folderId: null, position: 0, pinPos: null }
		]
	};
	const base = { rows, org, kind: null, sort: 'az' as const, folderId: null, q: '' };
	it('root: pinned in your order (folder, Liked, playlist), then unpinned folders and root playlists; nothing twice', () => {
		const v = libraryView(base);
		expect(v.pinned.map((e) => e.key)).toEqual(['folder:3', LIKED_KEY, playlistKey(id('e'))]);
		expect(v.entries.map((e) => e.key)).toEqual(['folder:1', playlistKey(id('a')), playlistKey(id('b'))]);
		const gym = v.entries[0]!;
		expect(gym.type === 'folder' && [gym.count, gym.children]).toEqual([2, 1]); // c, plus d inside Cardio
	});
	it('inside a folder: its subfolder, then its playlists; breadcrumbs know the parent', () => {
		const v = libraryView({ ...base, folderId: 1 });
		expect(v.folder?.name).toBe('Gym');
		expect(v.entries.map((e) => e.key)).toEqual(['folder:2', playlistKey(id('c'))]);
		const sub = libraryView({ ...base, folderId: 2 });
		expect(sub.parent?.name).toBe('Gym');
		expect(sub.entries.map((e) => e.key)).toEqual([playlistKey(id('d'))]);
	});
	it('custom order uses your positions', () => {
		const v = libraryView({ ...base, sort: 'custom' });
		expect(v.entries.map((e) => e.key)).toEqual(['folder:1', playlistKey(id('b')), playlistKey(id('a'))]);
	});
	it('kinds: flat across folders; Pinned and Folders views', () => {
		expect(libraryView({ ...base, kind: 'followed' }).entries.map((e) => e.key)).toEqual([playlistKey(id('d'))]);
		expect(libraryView({ ...base, kind: 'pinned' }).entries.map((e) => e.key)).toEqual(['folder:3', LIKED_KEY, playlistKey(id('e'))]);
		expect(libraryView({ ...base, kind: 'folders' }).entries.map((e) => e.key)).toEqual(['folder:3', 'folder:1', 'folder:2']);
		expect(libraryView({ ...base, kind: 'rules', categories: [{ key: 'top', name: 'Top' }] }).groups?.map((g) => g.rows.length)).toEqual([1]);
	});
	it('search finds playlists inside folders and folders by name', () => {
		expect(libraryView({ ...base, q: 'd li' }).entries.map((e) => e.key)).toEqual([playlistKey(id('d'))]);
		expect(libraryView({ ...base, q: 'card' }).entries.map((e) => e.key)).toEqual(['folder:2']);
		expect(libraryView({ ...base, q: 'liked' }).entries.map((e) => e.key)).toEqual([LIKED_KEY]);
	});
	it('a deleted folder: its items show at the root again', () => {
		const gone: Organiser = { folders: org.folders.filter((f) => f.id !== 1 && f.id !== 2), items: org.items };
		const v = libraryView({ ...base, org: gone });
		expect(v.entries.map((e) => e.key)).toContain(playlistKey(id('c')));
		expect(v.entries.map((e) => e.key)).toContain(playlistKey(id('d')));
	});
	it('move targets: top-level folders with their subfolders under them', () => {
		expect(moveTargets(org).map((t) => [t.name, t.depth])).toEqual([['Archive', 0], ['Gym', 0], ['Cardio', 1]]);
	});
	it('reorder moves one entry', () => {
		expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
		expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
	});
});

describe('v0.91 organiser input', () => {
	it('accepts playlist, Liked Songs and collection keys only', () => {
		expect(itemKeys([playlistKey(id('a')), LIKED_KEY, 'rotor:collection:0f3a9b2c-1d2e-4f5a-8b6c-7d8e9f0a1b2c'])).toHaveLength(3);
		expect(() => itemKeys(['spotify:album:' + id('a')])).toThrow(/Not a playlist/);
		expect(() => itemKeys([])).toThrow(/Nothing selected/);
	});
	it('pin targets split into items and folders, order kept', () => {
		expect(pinTargets(['folder:7', LIKED_KEY, 'folder:2'])).toEqual({ items: [LIKED_KEY], folders: [7, 2], order: ['folder:7', LIKED_KEY, 'folder:2'] });
		expect(() => pinTargets(['folder:x'])).toThrow();
	});
	it('the organiser never touches Spotify: no Spotify import in it', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../server/organiser.ts', import.meta.url), 'utf8');
		expect(src).not.toMatch(/spotify\/(api|write-guard)|services'|api\.spotify\.com/);
	});
});
