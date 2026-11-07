/**
 * Library + playlist detail (R2). Reads come from the mirror; owned/collab items are
 * fetched live (read-only) when the mirrored copy is older than the playlist's snapshot.
 * Managed settings (order preference, snapshot rebuild) are DB intents the Python crons
 * and hub jobs apply: same SQL as lib/playlist_settings.py.
 */
import type { Queryable } from '$lib/server/db';
import type { LibraryRow } from '$lib/shared/library';
import type { ManagedKind } from '$lib/shared/managed';
import type { TrackRow } from '$lib/shared/daily-types';
import type { OrderPref } from '$lib/shared/order-prefs';
import { nextRun } from '$lib/shared/cron';
import { BadInput } from '$lib/shared/custom';
import { isWrappedPlaylistName } from '$lib/shared/wrapped';
import { playlistTrackRows } from './daily';
import { ReadOnlyPlaylist } from './spotify/write-guard';
import type { SpotifyApi } from './spotify/api';

interface MirrorRow {
	playlist_id: string;
	name: string;
	image_url: string | null;
	managed_kind: ManagedKind | null;
	is_owned: boolean;
	is_collab: boolean;
	owner_name: string | null;
	owner_id: string;
	track_count: number | null;
	rule_category: string | null;
	snapshot_id: string | null;
	items_snapshot_id: string | null;
	removed_at: Date | null;
	first_seen_at?: Date | null;
}

export async function libraryRows(sql: Queryable): Promise<LibraryRow[]> {
	const rows = await sql<
		(MirrorRow & { expires_at: Date | null; last_played_on: Date | string | null; rotation_score: string | null })[]
	>`
		SELECT p.*, c.expires_at, h.last_played_on, h.rotation_score
		FROM spotify_playlists p
		LEFT JOIN custom_playlists c USING (playlist_id)
		LEFT JOIN playlist_rotation_history h USING (playlist_id)
		WHERE p.removed_at IS NULL`;
	return rows.map((r) => ({
		id: r.playlist_id,
		uri: `spotify:playlist:${r.playlist_id}`,
		name: r.name,
		imageUrl: r.image_url,
		kind: r.managed_kind,
		isOwned: r.is_owned,
		isCollab: r.is_collab,
		ownerName: r.owner_name,
		trackCount: r.track_count,
		category: r.rule_category,
		expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
		lastPlayedOn: r.last_played_on ? String(r.last_played_on instanceof Date ? r.last_played_on.toISOString() : r.last_played_on).slice(0, 10) : null,
		rotationScore: r.rotation_score === null ? null : Number(r.rotation_score),
		addedAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null
	}));
}

export interface RuleCategory {
	key: string;
	position: number;
	name: string;
	kind: string;
	playlistCount: number;
	nameForm: string;
	ruleNl: string;
	scheduleKind: string;
	scheduleNl: string;
	nextCreationNl: string;
	cron: string;
	cronJob: string;
	cronScript: string;
	memberVariation: string;
	variants: { label: string; full_name: string; rule_param: string }[];
	exampleNames: string[];
	notes: string;
	querySources: { function: string; source: string; error: string }[];
	exportedAt: string;
}

interface CategoryDb {
	key: string;
	position: number;
	name: string;
	kind: string;
	playlist_count: number;
	name_form: string;
	rule_nl: string;
	schedule_kind: string;
	schedule_nl: string;
	next_creation_nl: string;
	cron: string;
	cron_job: string;
	cron_script: string;
	member_variation: string;
	variants: RuleCategory['variants'];
	example_names: string[];
	notes: string;
	query_sources: RuleCategory['querySources'];
	exported_at: Date;
}

function toCategory(r: CategoryDb): RuleCategory {
	return {
		key: r.key,
		position: r.position,
		name: r.name,
		kind: r.kind,
		playlistCount: r.playlist_count,
		nameForm: r.name_form,
		ruleNl: r.rule_nl,
		scheduleKind: r.schedule_kind,
		scheduleNl: r.schedule_nl,
		nextCreationNl: r.next_creation_nl,
		cron: r.cron,
		cronJob: r.cron_job,
		cronScript: r.cron_script,
		memberVariation: r.member_variation,
		variants: r.variants ?? [],
		exampleNames: r.example_names ?? [],
		notes: r.notes,
		querySources: r.query_sources ?? [],
		exportedAt: new Date(r.exported_at).toISOString()
	};
}

export async function ruleCategories(sql: Queryable): Promise<RuleCategory[]> {
	const rows = await sql<CategoryDb[]>`SELECT * FROM playlist_rule_categories ORDER BY position`;
	return rows.map(toCategory);
}

export async function ruleCategory(sql: Queryable, key: string | null): Promise<RuleCategory | null> {
	if (!key) return null;
	const [r] = await sql<CategoryDb[]>`SELECT * FROM playlist_rule_categories WHERE key = ${key}`;
	return r ? toCategory(r) : null;
}

export async function mirrorRow(sql: Queryable, playlistId: string): Promise<MirrorRow | null> {
	const [r] = await sql<MirrorRow[]>`SELECT * FROM spotify_playlists WHERE playlist_id = ${playlistId}`;
	return r ?? null;
}

/** Managed intents need an owned playlist of the right kind in the mirror; anything else is 403. */
export async function requireManaged(sql: Queryable, playlistId: string, kind: ManagedKind): Promise<MirrorRow> {
	const row = await mirrorRow(sql, playlistId);
	if (!row || !row.is_owned || row.removed_at) throw new ReadOnlyPlaylist(playlistId, 'not_owned');
	if (row.managed_kind !== kind) throw new ReadOnlyPlaylist(playlistId, row.managed_kind ? 'wrong_kind' : 'no_managed_suffix');
	return row;
}

/** Same upsert as lib/playlist_settings.upsert_order_pref; applied at the next refresh. */
export async function setOrderPref(sql: Queryable, playlistId: string, pref: OrderPref): Promise<void> {
	const row = await requireManaged(sql, playlistId, 'auto_updating');
	await sql`
		INSERT INTO playlist_settings (playlist_id, playlist_name, order_pref) VALUES (${playlistId}, ${row.name}, ${pref})
		ON CONFLICT (playlist_id) DO UPDATE
			SET playlist_name = EXCLUDED.playlist_name, order_pref = EXCLUDED.order_pref, updated_at = now()`;
}

/** Same upsert as lib/playlist_settings.request_force_refresh. */
export async function requestRebuild(sql: Queryable, playlistId: string): Promise<void> {
	const row = await requireManaged(sql, playlistId, 'auto_snapshot');
	// R6: "Wrapped <year> · Auto 🤖📸" has no snapshot definition in lib/playlists.py; it is
	// rewritten by "Play your top 100" in Rotor Wrapped, never by the snapshot rebuild.
	if (isWrappedPlaylistName(row.name)) throw new BadInput('Wrapped playlists are rebuilt from Rotor Wrapped (Play your top 100)');
	await sql`
		INSERT INTO playlist_settings (playlist_id, playlist_name, force_refresh_requested_at) VALUES (${playlistId}, ${row.name}, now())
		ON CONFLICT (playlist_id) DO UPDATE
			SET playlist_name = EXCLUDED.playlist_name, force_refresh_requested_at = now(), updated_at = now()`;
}

interface RawItem {
	added_at?: string | null;
	track?: { uri?: string; name?: string; duration_ms?: number; artists?: { name: string }[] } | null;
	item?: { uri?: string; name?: string; duration_ms?: number; artists?: { name: string }[] } | null;
}

/** Re-read an owned/collab playlist's items from Spotify into the mirror (read-only call). */
export async function refreshItems(sql: Queryable, api: SpotifyApi, row: MirrorRow, maxItems = 2000): Promise<void> {
	const items: { uri: string; name: string | null; artist: string | null; duration: number | null; added: string | null }[] = [];
	for (let offset = 0; offset < maxItems; offset += 100) {
		const { data } = await api.get<{ items: RawItem[]; next: string | null }>(`/playlists/${row.playlist_id}/items`, { limit: 100, offset });
		for (const e of data?.items ?? []) {
			const t = e.item ?? e.track; // Feb 2026 renamed `track` → `item`
			if (t?.uri) items.push({ uri: t.uri, name: t.name ?? null, artist: (t.artists ?? []).map((a) => a.name).join(', ') || null, duration: t.duration_ms ?? null, added: e.added_at ?? null });
		}
		if (!data?.next) break;
	}
	await sql`DELETE FROM spotify_playlist_items WHERE playlist_id = ${row.playlist_id}`;
	if (items.length) {
		const values = items.map((t, position) => ({
			playlist_id: row.playlist_id,
			position,
			track_uri: t.uri,
			track_name: t.name,
			artist_name: t.artist,
			duration_ms: t.duration,
			added_at: t.added
		}));
		await sql`INSERT INTO spotify_playlist_items ${sql(values, 'playlist_id', 'position', 'track_uri', 'track_name', 'artist_name', 'duration_ms', 'added_at')}`;
	}
	await sql`
		UPDATE spotify_playlists SET items_snapshot_id = snapshot_id, items_synced_at = now(), track_count = ${items.length}
		WHERE playlist_id = ${row.playlist_id}`;
}

export interface PlaylistSettings {
	orderPref: string;
	forceRefreshRequestedAt: string | null;
	forceRefreshCompletedAt: string | null;
}

export async function playlistSettings(sql: Queryable, playlistId: string): Promise<PlaylistSettings> {
	const [r] = await sql<{ order_pref: string; force_refresh_requested_at: Date | null; force_refresh_completed_at: Date | null }[]>`
		SELECT order_pref, force_refresh_requested_at, force_refresh_completed_at FROM playlist_settings WHERE playlist_id = ${playlistId}`;
	return {
		orderPref: r?.order_pref ?? 'default',
		forceRefreshRequestedAt: r?.force_refresh_requested_at ? new Date(r.force_refresh_requested_at).toISOString() : null,
		forceRefreshCompletedAt: r?.force_refresh_completed_at ? new Date(r.force_refresh_completed_at).toISOString() : null
	};
}

export interface PlaylistDetailTracks {
	readable: boolean;
	rows: TrackRow[];
}

/** Track list for the detail page; refreshes the mirror's items first when they're stale. */
export async function playlistTracks(sql: Queryable, api: SpotifyApi, row: MirrorRow): Promise<PlaylistDetailTracks> {
	const readable = row.is_owned || row.is_collab;
	if (!readable) return { readable, rows: [] };
	if (!row.items_snapshot_id || row.items_snapshot_id !== row.snapshot_id) {
		try {
			await refreshItems(sql, api, row);
		} catch (e) {
			console.warn('[rotor] item refresh failed', row.playlist_id, e);
		}
	}
	return { readable, rows: await playlistTrackRows(sql, row.playlist_id) };
}

/** "Next refresh" for an Auto 🔄 playlist from its category's cron (UTC). */
export function nextRefresh(category: Pick<RuleCategory, 'scheduleKind' | 'cron'> | null, now: Date = new Date()): string | null {
	if (!category || category.scheduleKind !== 'refresh' || !category.cron) return null;
	return nextRun(category.cron, now)?.toISOString() ?? null;
}
