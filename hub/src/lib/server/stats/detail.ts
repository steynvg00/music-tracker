/**
 * Track / Artist / Album detail and Search over your own history (R3). Ports of
 * views/_stats_track_lookup.py, _stats_artist_lookup.py and _stats_album_lookup.py:
 * tracks aggregate every URI variant under one canonical recording (same ISRC), artists
 * count every credited artist (track_metadata.artist_ids), as Streamlit does.
 */
import type { Queryable } from '$lib/server/db';
import type { ManagedKind } from '$lib/shared/managed';
import { badgeGrid, type BadgeGridCategory, type SeriesPoint } from '$lib/shared/stats';
import { toBadgeEvent } from './sections';

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function likePattern(q: string): string {
	return `%${q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

// ── Track ────────────────────────────────────────────────────────────────────

export interface TrackDetail {
	uri: string;
	canonicalUri: string;
	name: string;
	artists: { name: string; id: string | null }[];
	album: { name: string | null; id: string | null };
	releaseDate: string | null;
	durationMs: number | null;
	isrc: string | null;
	liked: boolean;
	metrics: { plays: number; firstPlayedAt: string | null; lastPlayedAt: string | null; daysListened: number; skipRatePct: number; completionPct: number };
	perMonth: SeriesPoint[];
	endReasons: { reason: string; plays: number; pct: number }[];
	variants: { uri: string; albumName: string | null; albumType: string | null; releaseDate: string | null; plays: number; canonical: boolean }[];
	heardAlongside: { uri: string; name: string; artist: string; together: number }[];
	moreFromArtist: { uri: string; name: string; plays: number }[];
	inPlaylists: { id: string; name: string; kind: ManagedKind | null }[];
	badges: BadgeGridCategory[];
	scores: { composite: number | null; sticky: number | null; evergreen: number | null; flash: number | null; loop: number | null } | null;
}

export async function resolveCanonical(sql: Queryable, uri: string): Promise<{ canonical: string; variants: string[] }> {
	const [m] = await sql<{ canonical: string | null }[]>`SELECT canonical_track_uri AS canonical FROM track_metadata WHERE track_uri = ${uri}`;
	const canonical = m?.canonical ?? uri;
	const rows = await sql<{ track_uri: string }[]>`SELECT track_uri FROM track_metadata WHERE canonical_track_uri = ${canonical}`;
	return { canonical, variants: [...new Set([canonical, uri, ...rows.map((r) => r.track_uri)])] };
}

export async function trackDetail(sql: Queryable, uri: string): Promise<TrackDetail | null> {
	const { canonical, variants } = await resolveCanonical(sql, uri);
	const [[head], [tm], [liked], [m], perMonth, reasons, variantRows, alongside, more, playlists, badges, [score]] = await Promise.all([
		sql<{ track_name: string; artist_name: string; album_name: string }[]>`
			SELECT track_name, artist_name, album_name FROM hub.mv_track_stats WHERE track_uri = ANY(${variants})
			ORDER BY (track_uri = ${canonical}) DESC, plays DESC LIMIT 1`,
		sql<{ release_date: string | null; duration_ms: number | null; album_id: string | null; artist_ids: string[] | null; artist_names: string[] | null; isrc: string | null }[]>`
			SELECT release_date, duration_ms, album_id, artist_ids, artist_names, isrc FROM track_metadata WHERE track_uri = ${canonical}`,
		sql<{ liked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM liked_songs WHERE track_uri = ANY(${variants})) AS liked`,
		sql<{ plays: number; first_at: Date | null; last_at: Date | null; days: number; skips: number; done: number; with_reason: number }[]>`
			SELECT count(*)::int AS plays, min(played_at) AS first_at, max(played_at) AS last_at,
			       count(DISTINCT (played_at AT TIME ZONE 'Europe/Amsterdam')::date)::int AS days,
			       count(*) FILTER (WHERE reason_end = 'fwdbtn')::int AS skips,
			       count(*) FILTER (WHERE reason_end = 'trackdone')::int AS done,
			       count(*) FILTER (WHERE reason_end IS NOT NULL)::int AS with_reason
			FROM spotify_plays WHERE track_uri = ANY(${variants})`,
		sql<{ m: string; plays: number }[]>`
			SELECT to_char(played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS m, count(*)::int AS plays
			FROM spotify_plays WHERE track_uri = ANY(${variants}) GROUP BY 1 ORDER BY 1`,
		sql<{ reason: string; plays: number }[]>`
			SELECT reason_end AS reason, count(*)::int AS plays FROM spotify_plays
			WHERE track_uri = ANY(${variants}) AND reason_end IS NOT NULL GROUP BY 1 ORDER BY plays DESC, reason`,
		sql<{ track_uri: string; album_type: string | null; release_date: string | null; album_name: string | null; plays: number }[]>`
			SELECT v.uri AS track_uri, tm.album_type, tm.release_date, ts.album_name, coalesce(ts.plays, 0)::int AS plays
			FROM unnest(${variants}::text[]) AS v(uri)
			LEFT JOIN track_metadata tm ON tm.track_uri = v.uri
			LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = v.uri
			ORDER BY (v.uri = ${canonical}) DESC, plays DESC`,
		// "Usually heard alongside": plays within ±30 min of any play of this recording,
		// grouped by the companion's canonical, excluding this recording itself.
		sql<{ uri: string; together: number; name: string | null; artist: string | null }[]>`
			WITH target AS (SELECT played_at FROM spotify_plays WHERE track_uri = ANY(${variants})),
			co AS (
				SELECT coalesce(tm.canonical_track_uri, sp.track_uri) AS uri, count(*)::int AS together
				FROM target t
				JOIN spotify_plays sp ON sp.played_at BETWEEN t.played_at - interval '30 minutes' AND t.played_at + interval '30 minutes'
				LEFT JOIN track_metadata tm ON tm.track_uri = sp.track_uri
				WHERE sp.track_uri IS NOT NULL AND NOT (sp.track_uri = ANY(${variants}))
				GROUP BY 1
			)
			SELECT co.uri, co.together, ts.track_name AS name,
			       coalesce(array_to_string(tm.artist_names, ', '), ts.artist_name) AS artist
			FROM co LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = co.uri
			LEFT JOIN track_metadata tm ON tm.track_uri = co.uri
			WHERE co.uri <> ${canonical}
			ORDER BY co.together DESC, co.uri LIMIT 5`,
		sql<{ uri: string; name: string | null; plays: number }[]>`
			WITH me AS (SELECT artist_ids FROM track_metadata WHERE track_uri = ${canonical} AND artist_ids IS NOT NULL),
			c AS (
				SELECT coalesce(tm.canonical_track_uri, tm.track_uri) AS uri, sum(ts.plays)::int AS plays
				FROM track_metadata tm CROSS JOIN me
				JOIN hub.mv_track_stats ts ON ts.track_uri = tm.track_uri
				WHERE tm.artist_ids && me.artist_ids
				GROUP BY 1
			)
			SELECT c.uri, ts.track_name AS name, c.plays FROM c LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = c.uri
			WHERE c.uri <> ${canonical} ORDER BY c.plays DESC, c.uri LIMIT 5`,
		sql<{ id: string; name: string; kind: ManagedKind | null }[]>`
			SELECT DISTINCT p.playlist_id AS id, p.name, p.managed_kind AS kind
			FROM spotify_playlist_items i JOIN spotify_playlists p ON p.playlist_id = i.playlist_id
			WHERE i.track_uri = ANY(${variants}) AND p.removed_at IS NULL ORDER BY p.name LIMIT 30`,
		sql<{ entity_type: 'track'; entity_id: string; badge_type: string; awarded_at: Date; context: Record<string, unknown> | null; name: null; artist: null }[]>`
			SELECT entity_type, entity_id, badge_type, awarded_at, context, NULL AS name, NULL AS artist
			FROM badge_events WHERE entity_type = 'track' AND entity_id = ANY(${variants}) ORDER BY badge_type, awarded_at`,
		sql<{ composite_score: string | null; sticky_pct: string | null; evergreen_pct: string | null; flash_hit_pct: string | null; session_loop_pct: string | null }[]>`
			SELECT composite_score, sticky_pct, evergreen_pct, flash_hit_pct, session_loop_pct FROM track_popularity_scores WHERE track_uri = ${canonical}`
	]);
	if (!head && !(m && m.plays)) return null;
	const names = tm?.artist_names ?? (head?.artist_name ? [head.artist_name] : []);
	const ids = tm?.artist_ids ?? [];
	const total = reasons.reduce((a, r) => a + r.plays, 0);
	const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
	return {
		uri,
		canonicalUri: canonical,
		name: head?.track_name || 'Unknown track',
		artists: names.map((name, i) => ({ name, id: ids[i] ?? null })),
		album: { name: head?.album_name || null, id: tm?.album_id ?? null },
		releaseDate: tm?.release_date ?? null,
		durationMs: tm?.duration_ms ?? null,
		isrc: tm?.isrc ?? null,
		liked: !!liked?.liked,
		metrics: {
			plays: m?.plays ?? 0,
			firstPlayedAt: iso(m?.first_at),
			lastPlayedAt: iso(m?.last_at),
			daysListened: m?.days ?? 0,
			skipRatePct: m && m.plays ? Math.round((1000 * m.skips) / m.plays) / 10 : 0,
			completionPct: m && m.with_reason ? Math.round((1000 * m.done) / m.with_reason) / 10 : 0
		},
		perMonth: perMonth.map((r) => ({ x: r.m, y: r.plays })),
		endReasons: reasons.map((r) => ({ reason: r.reason, plays: r.plays, pct: total ? Math.round((1000 * r.plays) / total) / 10 : 0 })),
		variants: variantRows.map((r) => ({
			uri: r.track_uri,
			albumName: r.album_name || null,
			albumType: r.album_type,
			releaseDate: r.release_date,
			plays: r.plays,
			canonical: r.track_uri === canonical
		})),
		heardAlongside: alongside.map((r) => ({ uri: r.uri, name: r.name ?? 'Unknown track', artist: r.artist ?? '', together: r.together })),
		moreFromArtist: more.map((r) => ({ uri: r.uri, name: r.name ?? 'Unknown track', plays: r.plays })),
		inPlaylists: playlists,
		badges: badgeGrid('track', badges.map(toBadgeEvent)),
		scores: score
			? {
					composite: num(score.composite_score),
					sticky: num(score.sticky_pct),
					evergreen: num(score.evergreen_pct),
					flash: num(score.flash_hit_pct),
					loop: num(score.session_loop_pct)
				}
			: null
	};
}

// ── Artist ───────────────────────────────────────────────────────────────────

export interface ArtistDetail {
	id: string;
	name: string;
	metrics: { plays: number; tracks: number; firstPlayedAt: string | null; lastPlayedAt: string | null; plays30d: number; yearsActive: number };
	perMonth: SeriesPoint[];
	topTracks: { uri: string; name: string; plays: number }[];
	badges: BadgeGridCategory[];
	scores: { composite: number | null; sticky: number | null; evergreen: number | null; depth: number | null; saved: number | null } | null;
}

export async function artistDetail(sql: Queryable, id: string): Promise<ArtistDetail | null> {
	const [[a], perMonth, top, badges] = await Promise.all([
		sql<{ artist_name: string; plays: number; tracks: number; first_played_at: Date | null; last_played_at: Date | null; plays_30d: number }[]>`
			SELECT artist_name, plays, tracks, first_played_at, last_played_at, plays_30d FROM hub.mv_artist_stats WHERE artist_id = ${id}`,
		sql<{ m: string; plays: number }[]>`
			SELECT to_char(sp.played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS m, count(*)::int AS plays
			FROM spotify_plays sp JOIN track_metadata tm ON tm.track_uri = sp.track_uri
			WHERE ${id} = ANY(tm.artist_ids) AND sp.track_uri IS NOT NULL GROUP BY 1 ORDER BY 1`,
		sql<{ uri: string; name: string | null; plays: number }[]>`
			WITH c AS (
				SELECT coalesce(tm.canonical_track_uri, tm.track_uri) AS uri, sum(ts.plays)::int AS plays
				FROM track_metadata tm JOIN hub.mv_track_stats ts ON ts.track_uri = tm.track_uri
				WHERE ${id} = ANY(tm.artist_ids) GROUP BY 1
			)
			SELECT c.uri, ts.track_name AS name, c.plays FROM c LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = c.uri
			ORDER BY c.plays DESC, c.uri LIMIT 20`,
		sql<{ entity_type: 'artist'; entity_id: string; badge_type: string; awarded_at: Date; context: Record<string, unknown> | null; name: null; artist: null }[]>`
			SELECT entity_type, entity_id, badge_type, awarded_at, context, NULL AS name, NULL AS artist
			FROM badge_events WHERE entity_type = 'artist' AND entity_id = ${id} ORDER BY badge_type, awarded_at`
	]);
	if (!a) return null;
	const [score] = await sql<{ composite_score: string | null; sticky_pct: string | null; evergreen_pct: string | null; depth_pct: string | null; saved_count_pct: string | null }[]>`
		SELECT composite_score, sticky_pct, evergreen_pct, depth_pct, saved_count_pct FROM artist_popularity_scores WHERE artist_name = ${a.artist_name}`;
	const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
	return {
		id,
		name: a.artist_name,
		metrics: {
			plays: a.plays,
			tracks: a.tracks,
			firstPlayedAt: iso(a.first_played_at),
			lastPlayedAt: iso(a.last_played_at),
			plays30d: a.plays_30d,
			yearsActive: new Set(perMonth.map((r) => r.m.slice(0, 4))).size
		},
		perMonth: perMonth.map((r) => ({ x: r.m, y: r.plays })),
		topTracks: top.map((r) => ({ uri: r.uri, name: r.name ?? 'Unknown track', plays: r.plays })),
		badges: badgeGrid('artist', badges.map(toBadgeEvent)),
		scores: score
			? { composite: num(score.composite_score), sticky: num(score.sticky_pct), evergreen: num(score.evergreen_pct), depth: num(score.depth_pct), saved: num(score.saved_count_pct) }
			: null
	};
}

// ── Album ────────────────────────────────────────────────────────────────────

export interface AlbumDetail {
	id: string;
	name: string;
	artists: { name: string; id: string | null }[];
	releaseDate: string | null;
	metrics: { plays: number; uniqueTracks: number; firstPlayedAt: string | null; lastPlayedAt: string | null };
	perMonth: SeriesPoint[];
	tracks: { uri: string; name: string; plays: number; variants: number }[];
}

export async function albumDetail(sql: Queryable, id: string): Promise<AlbumDetail | null> {
	const [[head], [m], perMonth, tracks] = await Promise.all([
		sql<{ name: string | null; artist_names: string[] | null; artist_ids: string[] | null; release_date: string | null }[]>`
			SELECT (SELECT ts.album_name FROM hub.mv_track_stats ts JOIN track_metadata t2 ON t2.track_uri = ts.track_uri
			        WHERE t2.album_id = ${id} AND ts.album_name <> '' ORDER BY ts.plays DESC LIMIT 1) AS name,
			       tm.artist_names, tm.artist_ids, tm.release_date
			FROM track_metadata tm WHERE tm.album_id = ${id} ORDER BY tm.track_uri LIMIT 1`,
		sql<{ plays: number; tracks: number; first_at: Date | null; last_at: Date | null }[]>`
			SELECT count(*)::int AS plays, count(DISTINCT sp.track_uri)::int AS tracks, min(sp.played_at) AS first_at, max(sp.played_at) AS last_at
			FROM spotify_plays sp JOIN track_metadata tm ON tm.track_uri = sp.track_uri WHERE tm.album_id = ${id}`,
		sql<{ m: string; plays: number }[]>`
			SELECT to_char(sp.played_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM') AS m, count(*)::int AS plays
			FROM spotify_plays sp JOIN track_metadata tm ON tm.track_uri = sp.track_uri WHERE tm.album_id = ${id} GROUP BY 1 ORDER BY 1`,
		// Streamlit's album lookup: every canonical recording on the album, plays summed over ALL
		// its URI variants (album + single releases).
		sql<{ uri: string; name: string | null; plays: number; variants: number }[]>`
			WITH groups AS (
				SELECT DISTINCT coalesce(canonical_track_uri, track_uri) AS uri FROM track_metadata WHERE album_id = ${id}
			),
			plays AS (
				SELECT g.uri, coalesce(sum(ts.plays), 0)::int AS plays, count(DISTINCT tm.track_uri)::int AS variants
				FROM groups g
				JOIN track_metadata tm ON coalesce(tm.canonical_track_uri, tm.track_uri) = g.uri
				LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = tm.track_uri
				GROUP BY g.uri
			)
			SELECT p.uri, ts.track_name AS name, p.plays, p.variants FROM plays p LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = p.uri
			ORDER BY p.plays DESC, p.uri`
	]);
	if (!head) return null;
	const names = head.artist_names ?? [];
	return {
		id,
		name: head.name || 'Unknown album',
		artists: names.map((name, i) => ({ name, id: head.artist_ids?.[i] ?? null })),
		releaseDate: head.release_date,
		metrics: { plays: m?.plays ?? 0, uniqueTracks: m?.tracks ?? 0, firstPlayedAt: iso(m?.first_at), lastPlayedAt: iso(m?.last_at) },
		perMonth: perMonth.map((r) => ({ x: r.m, y: r.plays })),
		tracks: tracks.map((r) => ({ uri: r.uri, name: r.name ?? 'Unknown track', plays: r.plays, variants: r.variants }))
	};
}

// ── Search (your history and library, never the Spotify catalogue) ──────────

export interface SearchResults {
	q: string;
	tracks: { uri: string; name: string; artist: string; plays: number }[];
	artists: { id: string; name: string; plays: number }[];
	albums: { id: string; name: string; artist: string; plays: number }[];
	playlists: { id: string; name: string; kind: ManagedKind | null; isOwned: boolean }[];
}

export async function search(sql: Queryable, raw: string): Promise<SearchResults> {
	const q = raw.trim().slice(0, 100);
	if (q.length < 2) return { q, tracks: [], artists: [], albums: [], playlists: [] };
	const p = likePattern(q);
	const [tracks, artists, albums, playlists] = await Promise.all([
		sql<{ uri: string; name: string; artist: string; plays: number }[]>`
			WITH hits AS (
				SELECT coalesce(tm.canonical_track_uri, ts.track_uri) AS uri, sum(ts.plays)::int AS plays
				FROM hub.mv_track_stats ts LEFT JOIN track_metadata tm ON tm.track_uri = ts.track_uri
				WHERE ts.track_name ILIKE ${p} OR ts.artist_name ILIKE ${p}
				GROUP BY 1
			)
			SELECT h.uri, coalesce(ts.track_name, '') AS name, coalesce(ts.artist_name, '') AS artist, h.plays
			FROM hits h LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = h.uri
			ORDER BY h.plays DESC, h.uri LIMIT 20`,
		sql<{ id: string; name: string; plays: number }[]>`
			SELECT artist_id AS id, artist_name AS name, plays FROM hub.mv_artist_stats
			WHERE artist_name ILIKE ${p} ORDER BY plays DESC, artist_id LIMIT 10`,
		sql<{ id: string; name: string; artist: string; plays: number }[]>`
			SELECT tm.album_id AS id, max(ts.album_name) AS name, max(ts.artist_name) AS artist, sum(ts.plays)::int AS plays
			FROM hub.mv_track_stats ts JOIN track_metadata tm ON tm.track_uri = ts.track_uri
			WHERE ts.album_name ILIKE ${p} AND tm.album_id IS NOT NULL
			GROUP BY tm.album_id ORDER BY plays DESC, tm.album_id LIMIT 10`,
		sql<{ id: string; name: string; kind: ManagedKind | null; is_owned: boolean }[]>`
			SELECT playlist_id AS id, name, managed_kind AS kind, is_owned FROM spotify_playlists
			WHERE removed_at IS NULL AND name ILIKE ${p} ORDER BY name LIMIT 10`
	]);
	return {
		q,
		tracks,
		artists,
		albums,
		playlists: playlists.map((r) => ({ id: r.id, name: r.name, kind: r.kind, isOwned: r.is_owned }))
	};
}
