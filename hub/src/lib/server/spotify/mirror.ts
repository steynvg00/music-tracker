/**
 * On-demand playlist mirror (metadata only) with the hub token. The nightly Python job
 * (scripts/sync_playlist_mirror.py) also mirrors items; this one keeps names/covers/
 * snapshot ids fresh within the hour and finds the Daily pick playlist without a
 * paginated Spotify crawl inside a Play request.
 */
import type { Queryable } from '$lib/server/db';
import { managedKind } from '$lib/shared/managed';
import type { SpotifyApi } from './api';

export const MIRROR_MAX_AGE_MS = 60 * 60 * 1000;
const MIN_LISTED_FRACTION = 0.5;

interface RawPlaylist {
	id: string;
	name: string;
	owner?: { id?: string; display_name?: string | null };
	collaborative?: boolean;
	public?: boolean | null;
	snapshot_id?: string;
	images?: { url: string }[] | null;
	tracks?: { total?: number };
	items?: { total?: number };
}

export interface MirrorRow {
	playlist_id: string;
	name: string;
	owner_id: string;
	owner_name: string | null;
	is_owned: boolean;
	is_collab: boolean;
	is_public: boolean | null;
	managed_kind: string | null;
	snapshot_id: string | null;
	track_count: number | null;
	image_url: string | null;
}

export function toMirrorRow(p: RawPlaylist, ownerId: string): MirrorRow {
	const owner = p.owner?.id ?? '';
	const isOwned = owner === ownerId;
	// Feb 2026 Web API renamed the playlist's `tracks` object to `items`.
	const counts = p.items && typeof p.items === 'object' ? p.items : p.tracks;
	return {
		playlist_id: p.id,
		name: p.name ?? '',
		owner_id: owner,
		owner_name: p.owner?.display_name ?? null,
		is_owned: isOwned,
		is_collab: !!p.collaborative,
		is_public: p.public ?? null,
		managed_kind: isOwned ? managedKind(p.name) : null,
		snapshot_id: p.snapshot_id ?? null,
		track_count: counts?.total ?? null,
		image_url: p.images?.[0]?.url ?? null
	};
}

export async function fetchAllPlaylists(api: SpotifyApi): Promise<RawPlaylist[]> {
	const out: RawPlaylist[] = [];
	for (let offset = 0; offset < 5000; offset += 50) {
		const { data } = await api.get<{ items: (RawPlaylist | null)[]; next: string | null }>('/me/playlists', { limit: 50, offset });
		for (const p of data?.items ?? []) if (p?.id) out.push(p);
		if (!data?.next) break;
	}
	return out;
}

export async function mirrorAgeMs(sql: Queryable, now = Date.now()): Promise<number> {
	const [r] = await sql<{ t: Date | null }[]>`SELECT max(last_seen_at) AS t FROM spotify_playlists`;
	return r?.t ? now - new Date(r.t).getTime() : Number.POSITIVE_INFINITY;
}

export async function upsertMirrorRow(sql: Queryable, row: MirrorRow, runAt: Date): Promise<void> {
	await sql`
		INSERT INTO spotify_playlists (playlist_id, name, owner_id, owner_name, is_owned, is_collab, is_public,
			managed_kind, snapshot_id, track_count, image_url, first_seen_at, last_seen_at, removed_at, synced_by)
		VALUES (${row.playlist_id}, ${row.name}, ${row.owner_id}, ${row.owner_name}, ${row.is_owned}, ${row.is_collab},
			${row.is_public}, ${row.managed_kind}, ${row.snapshot_id}, ${row.track_count}, ${row.image_url},
			${runAt}, ${runAt}, NULL, 'hub')
		ON CONFLICT (playlist_id) DO UPDATE SET
			name = EXCLUDED.name, owner_id = EXCLUDED.owner_id, owner_name = EXCLUDED.owner_name,
			is_owned = EXCLUDED.is_owned, is_collab = EXCLUDED.is_collab, is_public = EXCLUDED.is_public,
			managed_kind = EXCLUDED.managed_kind, snapshot_id = EXCLUDED.snapshot_id,
			track_count = EXCLUDED.track_count, image_url = EXCLUDED.image_url,
			last_seen_at = EXCLUDED.last_seen_at, removed_at = NULL, synced_by = 'hub'`;
}

/** One statement for the whole listing (~200 rows) instead of a round trip per playlist. */
export async function upsertMirrorRows(sql: Queryable, rows: MirrorRow[], runAt: Date): Promise<void> {
	if (!rows.length) return;
	const values = rows.map((r) => ({ ...r, first_seen_at: runAt, last_seen_at: runAt, removed_at: null, synced_by: 'hub' }));
	await sql`
		INSERT INTO spotify_playlists ${sql(
			values,
			'playlist_id',
			'name',
			'owner_id',
			'owner_name',
			'is_owned',
			'is_collab',
			'is_public',
			'managed_kind',
			'snapshot_id',
			'track_count',
			'image_url',
			'first_seen_at',
			'last_seen_at',
			'removed_at',
			'synced_by'
		)}
		ON CONFLICT (playlist_id) DO UPDATE SET
			name = EXCLUDED.name, owner_id = EXCLUDED.owner_id, owner_name = EXCLUDED.owner_name,
			is_owned = EXCLUDED.is_owned, is_collab = EXCLUDED.is_collab, is_public = EXCLUDED.is_public,
			managed_kind = EXCLUDED.managed_kind, snapshot_id = EXCLUDED.snapshot_id,
			track_count = EXCLUDED.track_count, image_url = EXCLUDED.image_url,
			last_seen_at = EXCLUDED.last_seen_at, removed_at = NULL, synced_by = 'hub'`;
}

export interface SyncSummary {
	skipped: boolean;
	listed: number;
	removed: number;
}

/** Sync metadata if the mirror is older than an hour (or `force`). */
export async function syncMirror(sql: Queryable, api: SpotifyApi, ownerId: string, force = false): Promise<SyncSummary> {
	if (!force && (await mirrorAgeMs(sql)) < MIRROR_MAX_AGE_MS) return { skipped: true, listed: 0, removed: 0 };
	// Offset pagination can repeat an entry when the list shifts between pages: one row per id.
	const rows = [...new Map((await fetchAllPlaylists(api)).map((p) => [p.id, toMirrorRow(p, ownerId)])).values()];
	const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
	const [counts] = await sql<{ live: number }[]>`SELECT count(*)::int AS live FROM spotify_playlists WHERE removed_at IS NULL`;
	const runAt = clock!.now;
	const live = counts?.live ?? 0;
	await upsertMirrorRows(sql, rows, runAt);
	let removed = 0;
	if (rows.length >= MIN_LISTED_FRACTION * live) {
		const res = await sql`UPDATE spotify_playlists SET removed_at = ${runAt} WHERE removed_at IS NULL AND last_seen_at < ${runAt}`;
		removed = res.count;
	}
	return { skipped: false, listed: rows.length, removed };
}
