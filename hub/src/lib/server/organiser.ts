/**
 * Library organiser (v0.91, migration 0034): pins, folders, custom order. Database only: nothing in
 * this module talks to Spotify (it doesn't even import the Spotify client), so organising can never
 * change a playlist or your Spotify library.
 */
import type { Queryable, Sql } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';
import { ITEM_KEY, MAX_FOLDER_NAME, type LibFolder, type LibItem, type Organiser } from '$lib/shared/library';

interface FolderRow {
	id: string | number;
	name: string;
	parent_id: string | number | null;
	position: number;
	pin_pos: number | null;
}
interface ItemRow {
	item_key: string;
	folder_id: string | number | null;
	position: number;
	pin_pos: number | null;
}
const num = (v: string | number | null) => (v === null ? null : Number(v));
const toFolder = (r: FolderRow): LibFolder => ({ id: Number(r.id), name: r.name, parentId: num(r.parent_id), position: r.position, pinPos: r.pin_pos });
const toItem = (r: ItemRow): LibItem => ({ key: r.item_key, folderId: num(r.folder_id), position: r.position, pinPos: r.pin_pos });

export async function organiser(sql: Queryable): Promise<Organiser> {
	const [folders, items] = await Promise.all([
		sql<FolderRow[]>`SELECT id, name, parent_id, position, pin_pos FROM library_folders ORDER BY id`,
		sql<ItemRow[]>`SELECT item_key, folder_id, position, pin_pos FROM library_items ORDER BY item_key`
	]);
	return { folders: folders.map(toFolder), items: items.map(toItem) };
}

function folderName(v: unknown): string {
	const s = typeof v === 'string' ? v.trim() : '';
	if (!s) throw new BadInput('A folder needs a name');
	if (s.length > MAX_FOLDER_NAME) throw new BadInput(`Folder names are at most ${MAX_FOLDER_NAME} characters`);
	return s;
}
function folderId(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0) throw new BadInput('Unknown folder');
	return n;
}
export function itemKeys(v: unknown, max = 500): string[] {
	if (!Array.isArray(v) || !v.length) throw new BadInput('Nothing selected');
	if (v.length > max) throw new BadInput(`At most ${max} at once`);
	const keys = [...new Set(v.map(String))];
	for (const k of keys) if (!ITEM_KEY.test(k)) throw new BadInput(`Not a playlist: ${k.slice(0, 60)}`);
	return keys;
}
/** Pin targets: item keys or "folder:<id>". */
export function pinTargets(v: unknown, max = 500): { items: string[]; folders: number[]; order: string[] } {
	if (!Array.isArray(v) || !v.length) throw new BadInput('Nothing selected');
	if (v.length > max) throw new BadInput(`At most ${max} at once`);
	const order = [...new Set(v.map(String))];
	const items: string[] = [];
	const folders: number[] = [];
	for (const t of order) {
		const m = /^folder:(\d+)$/.exec(t);
		if (m) folders.push(Number(m[1]));
		else if (ITEM_KEY.test(t)) items.push(t);
		else throw new BadInput(`Not a playlist or folder: ${t.slice(0, 60)}`);
	}
	return { items, folders, order };
}

/** Postgres check_violation from the one-level trigger → a 400 with its message. */
function nestingError(e: unknown): never {
	if (e && typeof e === 'object' && (e as { code?: string }).code === '23514') throw new BadInput('Folders nest one level deep');
	throw e;
}

async function requireFolder(sql: Queryable, id: number): Promise<LibFolder> {
	const [r] = await sql<FolderRow[]>`SELECT id, name, parent_id, position, pin_pos FROM library_folders WHERE id = ${id}`;
	if (!r) throw new BadInput('Unknown folder');
	return toFolder(r);
}

export async function createFolder(sql: Queryable, body: { name?: unknown; parentId?: unknown }): Promise<LibFolder> {
	const name = folderName(body.name);
	const parent = folderId(body.parentId);
	if (parent !== null) await requireFolder(sql, parent);
	try {
		const [r] = await sql<FolderRow[]>`
			INSERT INTO library_folders (name, parent_id, position)
			VALUES (${name}, ${parent}, (SELECT coalesce(max(position) + 1, 0) FROM library_folders WHERE parent_id IS NOT DISTINCT FROM ${parent}))
			RETURNING id, name, parent_id, position, pin_pos`;
		return toFolder(r!);
	} catch (e) {
		nestingError(e);
	}
}

export async function updateFolder(sql: Queryable, id: number, body: { name?: unknown; parentId?: unknown }): Promise<LibFolder> {
	await requireFolder(sql, id);
	if (body.name !== undefined) await sql`UPDATE library_folders SET name = ${folderName(body.name)} WHERE id = ${id}`;
	if (body.parentId !== undefined) {
		const parent = folderId(body.parentId);
		if (parent === id) throw new BadInput('A folder can’t be inside itself');
		if (parent !== null) await requireFolder(sql, parent);
		try {
			await sql`UPDATE library_folders SET parent_id = ${parent} WHERE id = ${id}`;
		} catch (e) {
			nestingError(e);
		}
	}
	return requireFolder(sql, id);
}

/** Delete a folder: its playlists and subfolders go back to the root (ON DELETE SET NULL). */
export async function deleteFolder(sql: Queryable, id: number): Promise<{ deleted: number; movedToRoot: number }> {
	const [n] = await sql<{ n: number }[]>`
		SELECT (SELECT count(*) FROM library_items WHERE folder_id = ${id})::int + (SELECT count(*) FROM library_folders WHERE parent_id = ${id})::int AS n`;
	const r = await sql`DELETE FROM library_folders WHERE id = ${id}`;
	if (!r.count) throw new BadInput('Unknown folder');
	return { deleted: id, movedToRoot: n?.n ?? 0 };
}

export async function moveItems(sql: Sql, keysIn: unknown, folderIn: unknown): Promise<{ moved: number }> {
	const keys = itemKeys(keysIn);
	const folder = folderId(folderIn);
	if (folder !== null) {
		await requireFolder(sql, folder);
		if (keys.some((k) => k.startsWith('rotor:collection:'))) throw new BadInput('YouTube and SoundCloud collections can be pinned, not put in folders');
	}
	await sql.begin(async (tx) => {
		const [{ base }] = (await tx`SELECT coalesce(max(position) + 1, 0) AS base FROM library_items WHERE folder_id IS NOT DISTINCT FROM ${folder}`) as unknown as [{ base: number }];
		let i = 0;
		for (const k of keys) {
			await tx`
				INSERT INTO library_items (item_key, folder_id, position) VALUES (${k}, ${folder}, ${base + i})
				ON CONFLICT (item_key) DO UPDATE SET folder_id = EXCLUDED.folder_id, position = EXCLUDED.position, updated_at = now()`;
			i++;
		}
	});
	return { moved: keys.length };
}

/** Pin (appended to the end of the pinned list, in the given order) or unpin. No cap. */
export async function setPinned(sql: Sql, targetsIn: unknown, pinned: boolean): Promise<{ changed: number }> {
	const t = pinTargets(targetsIn);
	for (const f of t.folders) await requireFolder(sql, f);
	await sql.begin(async (tx) => {
		if (!pinned) {
			if (t.items.length) await tx`UPDATE library_items SET pin_pos = NULL, updated_at = now() WHERE item_key = ANY(${t.items}::text[])`;
			if (t.folders.length) await tx`UPDATE library_folders SET pin_pos = NULL WHERE id = ANY(${t.folders}::bigint[])`;
			return;
		}
		const [{ base }] = (await tx`
			SELECT greatest((SELECT coalesce(max(pin_pos), -1) FROM library_items), (SELECT coalesce(max(pin_pos), -1) FROM library_folders)) + 1 AS base`) as unknown as [{ base: number }];
		let i = 0;
		for (const target of t.order) {
			const m = /^folder:(\d+)$/.exec(target);
			if (m) await tx`UPDATE library_folders SET pin_pos = coalesce(pin_pos, ${base + i}) WHERE id = ${Number(m[1])}`;
			else
				await tx`
					INSERT INTO library_items (item_key, pin_pos) VALUES (${target}, ${base + i})
					ON CONFLICT (item_key) DO UPDATE SET pin_pos = coalesce(library_items.pin_pos, EXCLUDED.pin_pos), updated_at = now()`;
			i++;
		}
	});
	return { changed: t.order.length };
}

/** Drag to reorder the pinned list: positions follow `targets`; pinned ones not listed keep their relative order after. */
export async function reorderPins(sql: Sql, targetsIn: unknown): Promise<Organiser> {
	const t = pinTargets(targetsIn);
	await sql.begin(async (tx) => {
		const rest = (await tx`
			SELECT 'folder:' || id AS t, pin_pos FROM library_folders WHERE pin_pos IS NOT NULL
			UNION ALL SELECT item_key, pin_pos FROM library_items WHERE pin_pos IS NOT NULL
			ORDER BY pin_pos`) as unknown as { t: string }[];
		const listed = new Set(t.order);
		const order = [...t.order.filter((x) => rest.some((r) => r.t === x)), ...rest.map((r) => r.t).filter((x) => !listed.has(x))];
		let i = 0;
		for (const target of order) {
			const m = /^folder:(\d+)$/.exec(target);
			if (m) await tx`UPDATE library_folders SET pin_pos = ${i} WHERE id = ${Number(m[1])}`;
			else await tx`UPDATE library_items SET pin_pos = ${i}, updated_at = now() WHERE item_key = ${target}`;
			i++;
		}
	});
	return organiser(sql);
}

/** Custom order inside one folder (or the root): folders ("folder:<id>") and playlists. */
export async function reorderLevel(sql: Sql, folderIn: unknown, targetsIn: unknown): Promise<Organiser> {
	const folder = folderId(folderIn);
	const t = pinTargets(targetsIn, 2000);
	await sql.begin(async (tx) => {
		let i = 0;
		for (const target of t.order) {
			const m = /^folder:(\d+)$/.exec(target);
			if (m) await tx`UPDATE library_folders SET position = ${i} WHERE id = ${Number(m[1])} AND parent_id IS NOT DISTINCT FROM ${folder}`;
			else if (folder !== null) await tx`UPDATE library_items SET position = ${i}, updated_at = now() WHERE item_key = ${target} AND folder_id = ${folder}`;
			// The root: a playlist you never organised has no row yet.
			else
				await tx`
					INSERT INTO library_items (item_key, folder_id, position) VALUES (${target}, NULL, ${i})
					ON CONFLICT (item_key) DO UPDATE SET position = EXCLUDED.position, updated_at = now()
					WHERE library_items.folder_id IS NULL`;
			i++;
		}
	});
	return organiser(sql);
}
