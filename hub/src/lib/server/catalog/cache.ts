/**
 * Storage-light catalog cache (migration 0031). Rules:
 *   - written ONLY when you open an artist page (no background crawl);
 *   - TTL 7 days: an older row is refetched on the next open (served stale if Spotify refuses);
 *   - hard cap (CATALOG_CACHE_CAP_BYTES, default 20 MB) on the logical size (pg_column_size of the
 *     rows), held by evicting the least recently opened artists after every write;
 *   - "Appears on": only the artist's own tracks, in batches, never rewritten. Full tracklists are
 *     never stored (catalog/service.ts fetches them live).
 */
import { env } from '$env/dynamic/private';
import type { Queryable } from '$lib/server/db';
import {
	packOwnTrack,
	packRelease,
	shortCover,
	unpackOwnTrack,
	unpackRelease,
	longCover,
	type CatalogTrack,
	type PackedRelease,
	type PackedTrack,
	type Release
} from '$lib/shared/catalog';

export const TTL_DAYS = 7;
export const DEFAULT_CAP_BYTES = 20 * 1024 * 1024;

export function capBytes(): number {
	const v = Number(env.CATALOG_CACHE_CAP_BYTES);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_CAP_BYTES;
}
export function ttlMs(): number {
	return TTL_DAYS * 86_400_000;
}

export interface CachedArtist {
	artist: { id: string; name: string; image: string | null };
	releases: Release[];
	fetchedAt: Date;
	fresh: boolean;
}

interface ArtistRow {
	artist_id: string;
	name: string;
	image: string | null;
	releases: PackedRelease[];
	fetched_at: Date;
}

export async function readArtist(sql: Queryable, id: string, now: Date = new Date()): Promise<CachedArtist | null> {
	const [r] = await sql<ArtistRow[]>`
		SELECT artist_id, name, image, releases, fetched_at FROM catalog_artist_cache WHERE artist_id = ${id}`;
	if (!r) return null;
	return {
		artist: { id: r.artist_id, name: r.name, image: longCover(r.image) },
		releases: (r.releases ?? []).map(unpackRelease),
		fetchedAt: new Date(r.fetched_at),
		fresh: now.getTime() - new Date(r.fetched_at).getTime() < ttlMs()
	};
}

export async function touchArtist(sql: Queryable, id: string, now: Date = new Date()): Promise<void> {
	await sql`UPDATE catalog_artist_cache SET accessed_at = ${now} WHERE artist_id = ${id}`;
}

/** (Re)write one artist: its releases replace the old ones, its appears batches start over. */
export async function writeArtist(sql: Queryable, artist: { id: string; name: string; image: string | null }, releases: Release[], now: Date = new Date()): Promise<void> {
	const packed = JSON.stringify(releases.map(packRelease));
	await sql`DELETE FROM catalog_appears_cache WHERE artist_id = ${artist.id}`;
	await sql`
		INSERT INTO catalog_artist_cache (artist_id, name, image, releases, fetched_at, accessed_at)
		VALUES (${artist.id}, ${artist.name}, ${shortCover(artist.image)}, ${packed}::text::jsonb, ${now}, ${now})
		ON CONFLICT (artist_id) DO UPDATE SET name = EXCLUDED.name, image = EXCLUDED.image, releases = EXCLUDED.releases,
		  fetched_at = EXCLUDED.fetched_at, accessed_at = EXCLUDED.accessed_at`;
	await recomputeBytes(sql, artist.id);
}

/** Cached own tracks per appears-on album of this artist (albums without an entry aren't cached). */
export async function readAppears(sql: Queryable, artist: { id: string; name: string }): Promise<Map<string, CatalogTrack[]>> {
	const rows = await sql<{ tracks: Record<string, PackedTrack[]> }[]>`
		SELECT tracks FROM catalog_appears_cache WHERE artist_id = ${artist.id} ORDER BY fetched_at`;
	const out = new Map<string, CatalogTrack[]>();
	for (const r of rows) for (const [album, list] of Object.entries(r.tracks ?? {})) out.set(album, list.map((p) => unpackOwnTrack(p, artist)));
	return out;
}

export async function writeAppears(sql: Queryable, artistId: string, batch: Map<string, CatalogTrack[]>, now: Date = new Date()): Promise<void> {
	if (!batch.size) return;
	const first = [...batch.keys()].sort()[0]!;
	const obj = Object.fromEntries([...batch].map(([album, list]) => [album, list.map(packOwnTrack)]));
	await sql`
		INSERT INTO catalog_appears_cache (artist_id, first_album, tracks, fetched_at)
		VALUES (${artistId}, ${first}, ${JSON.stringify(obj)}::text::jsonb, ${now})
		ON CONFLICT (artist_id, first_album) DO NOTHING`;
	await recomputeBytes(sql, artistId);
}

export async function recomputeBytes(sql: Queryable, artistId: string): Promise<void> {
	await sql`
		UPDATE catalog_artist_cache a
		SET bytes = pg_column_size(a.*) + coalesce((SELECT sum(pg_column_size(p.*)) FROM catalog_appears_cache p WHERE p.artist_id = a.artist_id), 0)::int
		WHERE a.artist_id = ${artistId}`;
}

/**
 * Keep the cache under the cap: newest-opened artists are kept until the running total passes the
 * cap, the rest go (appears rows cascade). `keep` (the artist being viewed) is never evicted.
 */
export async function enforceCap(sql: Queryable, keep: string, cap: number = capBytes()): Promise<string[]> {
	const rows = await sql<{ artist_id: string }[]>`
		WITH ranked AS (
			SELECT artist_id, sum(bytes) OVER (ORDER BY (artist_id = ${keep}) DESC, accessed_at DESC, artist_id) AS running
			FROM catalog_artist_cache
		)
		DELETE FROM catalog_artist_cache c USING ranked r
		WHERE c.artist_id = r.artist_id AND r.running > ${cap} AND c.artist_id <> ${keep}
		RETURNING c.artist_id`;
	if (rows.length) await sql`UPDATE catalog_cache_stats SET evictions = evictions + ${rows.length}`;
	return rows.map((r) => r.artist_id);
}

export async function countStats(sql: Queryable, d: { hits?: number; misses?: number; calls?: number; rateLimited?: number }): Promise<void> {
	const h = d.hits ?? 0;
	const m = d.misses ?? 0;
	const c = d.calls ?? 0;
	const r = d.rateLimited ?? 0;
	if (!h && !m && !c && !r) return;
	await sql`UPDATE catalog_cache_stats SET hits = hits + ${h}, misses = misses + ${m}, spotify_calls = spotify_calls + ${c}, rate_limited = rate_limited + ${r}`;
}

export interface CacheHealth {
	artists: number;
	logicalBytes: number;
	physicalBytes: number;
	capBytes: number;
	ttlDays: number;
	hits: number;
	misses: number;
	hitRatePct: number | null;
	evictions: number;
	spotifyCalls: number;
	rateLimited: number;
	since: string | null;
}

/** For Data health. Throws (→ the block is blanked) when 0031 isn't applied. */
export async function cacheHealth(sql: Queryable): Promise<CacheHealth> {
	const [r] = await sql<
		{ artists: number; logical: string; physical: string; hits: string; misses: string; evictions: string; calls: string; limited: string; since: Date | null }[]
	>`
		SELECT (SELECT count(*)::int FROM catalog_artist_cache) AS artists,
		       (SELECT coalesce(sum(bytes), 0)::text FROM catalog_artist_cache) AS logical,
		       (pg_total_relation_size('catalog_artist_cache') + pg_total_relation_size('catalog_appears_cache'))::text AS physical,
		       s.hits::text, s.misses::text, s.evictions::text, s.spotify_calls::text AS calls, s.rate_limited::text AS limited, s.since
		FROM catalog_cache_stats s`;
	const hits = Number(r?.hits ?? 0);
	const misses = Number(r?.misses ?? 0);
	return {
		artists: r?.artists ?? 0,
		logicalBytes: Number(r?.logical ?? 0),
		physicalBytes: Number(r?.physical ?? 0),
		capBytes: capBytes(),
		ttlDays: TTL_DAYS,
		hits,
		misses,
		hitRatePct: hits + misses ? Math.round((1000 * hits) / (hits + misses)) / 10 : null,
		evictions: Number(r?.evictions ?? 0),
		spotifyCalls: Number(r?.calls ?? 0),
		rateLimited: Number(r?.limited ?? 0),
		since: r?.since ? new Date(r.since).toISOString() : null
	};
}
