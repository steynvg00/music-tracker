/** Enrichment for the player proxy: "Playing from" + "Your history with this track". */
import type { Queryable } from '$lib/server/db';
import type { ContextInfo, TrackStats } from '$lib/shared/player-types';
import { playlistIdFromUri } from './spotify/api';

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

export class TtlCache<V> {
	readonly #m = new Map<string, { v: V; at: number }>();
	constructor(
		private readonly ttlMs: number,
		private readonly max: number,
		private readonly now: () => number = Date.now
	) {}
	get(k: string): V | undefined {
		const e = this.#m.get(k);
		if (!e) return undefined;
		if (this.now() - e.at > this.ttlMs) {
			this.#m.delete(k);
			return undefined;
		}
		return e.v;
	}
	set(k: string, v: V): void {
		if (this.#m.size >= this.max) this.#m.delete(this.#m.keys().next().value as string);
		this.#m.set(k, { v, at: this.now() });
	}
}

const trackCache = new TtlCache<TrackStats>(TTL_MS, MAX_ENTRIES);
const contextCache = new TtlCache<ContextInfo | null>(60_000, MAX_ENTRIES);

/** One track's lifetime stats: index on track_uri, ~23 ms measured (04-architecture.md §6.4). */
export async function trackStats(sql: Queryable, uri: string): Promise<TrackStats> {
	const hit = trackCache.get(uri);
	if (hit) return hit;
	const [r] = await sql<{ plays: number; first: Date | null; last: Date | null; badges: number }[]>`
		SELECT
			(SELECT count(*)::int FROM spotify_plays WHERE track_uri = ${uri}) AS plays,
			(SELECT min(played_at) FROM spotify_plays WHERE track_uri = ${uri}) AS first,
			(SELECT max(played_at) FROM spotify_plays WHERE track_uri = ${uri}) AS last,
			(SELECT count(*)::int FROM badge_events WHERE entity_type = 'track' AND entity_id = ${uri}) AS badges`;
	const stats: TrackStats = {
		uri,
		plays: r?.plays ?? 0,
		firstPlayedAt: r?.first ? new Date(r.first).toISOString() : null,
		lastPlayedAt: r?.last ? new Date(r.last).toISOString() : null,
		badges: r?.badges ?? 0
	};
	trackCache.set(uri, stats);
	return stats;
}

/** Resolve a playlist context through the mirror (no Spotify call). */
export async function contextInfo(sql: Queryable, uri: string | null | undefined, ownerId: string): Promise<ContextInfo | null> {
	if (!uri) return null;
	if (uri === `spotify:user:${ownerId}:collection`) {
		return { uri, name: 'Liked Songs', kind: null, isOwned: true, imageUrl: null };
	}
	const id = playlistIdFromUri(uri);
	if (!id) return null;
	const hit = contextCache.get(uri);
	if (hit !== undefined) return hit;
	const [r] = await sql<{ name: string; managed_kind: ContextInfo['kind']; is_owned: boolean; image_url: string | null }[]>`
		SELECT name, managed_kind, is_owned, image_url FROM spotify_playlists WHERE playlist_id = ${id}`;
	const info = r ? { uri, name: r.name, kind: r.managed_kind, isOwned: r.is_owned, imageUrl: r.image_url } : null;
	contextCache.set(uri, info);
	return info;
}
