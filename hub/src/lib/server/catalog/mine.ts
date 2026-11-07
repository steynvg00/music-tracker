/**
 * "My numbers" for the Artist pages (beta): everything here comes from your own data (plays,
 * liked songs, badges), never from Spotify. Plays of a track count every URI variant of the same
 * recording (ISRC canonical, like the R3 track page).
 */
import type { Queryable } from '$lib/server/db';
import { badgeGrid } from '$lib/shared/stats';
import type { ArtistMine } from '$lib/shared/catalog';
import { toBadgeEvent } from '$lib/server/stats/sections';

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export async function artistMine(sql: Queryable, id: string): Promise<ArtistMine> {
	const [[a], [h], badges] = await Promise.all([
		sql<{ plays: number; tracks: number; first_played_at: Date | null; last_played_at: Date | null }[]>`
			SELECT plays, tracks, first_played_at, last_played_at FROM hub.mv_artist_stats WHERE artist_id = ${id}`,
		// @> uses the GIN index on artist_ids; ms has 0026's duration fallback.
		sql<{ ms: string }[]>`
			SELECT coalesce(sum(ts.ms), 0)::text AS ms
			FROM track_metadata tm JOIN hub.mv_track_stats ts ON ts.track_uri = tm.track_uri
			WHERE tm.artist_ids @> ARRAY[${id}]::text[]`,
		sql<{ entity_type: 'artist'; entity_id: string; badge_type: string; awarded_at: Date; context: Record<string, unknown> | null; name: null; artist: null }[]>`
			SELECT entity_type, entity_id, badge_type, awarded_at, context, NULL AS name, NULL AS artist
			FROM badge_events WHERE entity_type = 'artist' AND entity_id = ${id} ORDER BY awarded_at DESC`
	]);
	const earned = badgeGrid('artist', badges.map(toBadgeEvent)).flatMap((c) =>
		c.chips.filter((x) => x.earned).map((x) => ({ type: x.type, label: x.count > 1 ? `${x.label} ×${x.count}` : x.label, emoji: c.emoji, awardedAt: x.firstAt ?? '' }))
	);
	return {
		plays: a?.plays ?? 0,
		hours: Math.round(Number(h?.ms ?? 0) / 360_000) / 10,
		tracks: a?.tracks ?? 0,
		firstPlayedAt: iso(a?.first_played_at),
		lastPlayedAt: iso(a?.last_played_at),
		badges: earned.sort((x, y) => y.awardedAt.localeCompare(x.awardedAt))
	};
}

/** Plays + liked per release id (tracks whose metadata points at that album). */
export async function releaseMine(sql: Queryable, albumIds: string[]): Promise<Map<string, { plays: number; liked: boolean }>> {
	if (!albumIds.length) return new Map();
	const rows = await sql<{ album_id: string; plays: number; liked: boolean }[]>`
		SELECT tm.album_id, coalesce(sum(ts.plays), 0)::int AS plays, bool_or(l.track_uri IS NOT NULL) AS liked
		FROM track_metadata tm
		LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = tm.track_uri
		LEFT JOIN liked_songs l ON l.track_uri = tm.track_uri
		WHERE tm.album_id = ANY(${albumIds}::text[])
		GROUP BY tm.album_id`;
	return new Map(rows.map((r) => [r.album_id, { plays: r.plays, liked: !!r.liked }]));
}

/** Plays (all variants of the recording) + liked per track URI. */
export async function trackMine(sql: Queryable, uris: string[]): Promise<Map<string, { plays: number; liked: boolean }>> {
	const list = [...new Set(uris)];
	if (!list.length) return new Map();
	const rows = await sql<{ uri: string; plays: number; liked: boolean }[]>`
		WITH q AS (SELECT unnest(${list}::text[]) AS uri),
		c AS (SELECT q.uri, coalesce(tm.canonical_track_uri, q.uri) AS canon FROM q LEFT JOIN track_metadata tm ON tm.track_uri = q.uri),
		v AS (
			SELECT c.uri, c.uri AS variant FROM c
			UNION SELECT c.uri, c.canon FROM c
			UNION SELECT c.uri, tm.track_uri FROM c JOIN track_metadata tm ON tm.canonical_track_uri = c.canon
		)
		SELECT v.uri, coalesce(sum(ts.plays), 0)::int AS plays, bool_or(l.track_uri IS NOT NULL) AS liked
		FROM v
		LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = v.variant
		LEFT JOIN liked_songs l ON l.track_uri = v.variant
		GROUP BY v.uri`;
	return new Map(rows.map((r) => [r.uri, { plays: r.plays, liked: !!r.liked }]));
}
