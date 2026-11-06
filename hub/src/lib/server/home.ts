/**
 * /api/home payload: health, today's deck, shortcuts, the week tiles (index-range queries on
 * spotify_plays.played_at), Fresh, Coming back around (R1) and, since R3, the rollup-backed
 * stats from hub.home_payload(): streak, month tiles, On this day, Recent badges.
 */
import type { Sql } from '$lib/server/db';
import { MANAGED_SUFFIXES, type ManagedKind } from '$lib/shared/managed';
import type { HomePayload, HomeStats, HomeTiles, PlaylistCard } from '$lib/shared/daily-types';
import { isRollupsMissing } from './stats/http';
import { countCollections } from './elsewhere';
import { comingUp } from './radar';
import { loadDeck } from './daily';
import { connectionStatus, type Health } from './spotify/token';

export const SHORTCUT_NAMES = [
	`Top 30 last 30 days${MANAGED_SUFFIXES.auto_updating}`,
	`Forgotten favorites${MANAGED_SUFFIXES.auto_updating}`,
	`Missed new tracks · popular artists${MANAGED_SUFFIXES.auto_updating}`,
	`My Monthly #1${MANAGED_SUFFIXES.auto_updating}`
];
const MISSED_NEW_NAMES = [
	`Missed new tracks · popular artists${MANAGED_SUFFIXES.auto_updating}`,
	`Missed new tracks · other artists${MANAGED_SUFFIXES.auto_updating}`
];

interface PlRow {
	playlist_id: string;
	name: string;
	image_url: string | null;
	managed_kind: ManagedKind | null;
	is_owned: boolean;
	is_collab: boolean;
	owner_name: string | null;
	track_count: number | null;
}

export function card(r: PlRow, subtitle: string | null = null): PlaylistCard {
	return {
		id: r.playlist_id,
		uri: `spotify:playlist:${r.playlist_id}`,
		name: r.name,
		imageUrl: r.image_url,
		kind: r.managed_kind,
		isOwned: r.is_owned,
		isCollab: r.is_collab,
		ownerName: r.owner_name,
		trackCount: r.track_count,
		subtitle
	};
}

/** Ingest freshness: amber after 24 h without a new play, red after 72 h. */
export function ingestHealth(lastPlayAt: Date | null, now: Date = new Date()): Health {
	if (!lastPlayAt) return 'danger';
	const h = (now.getTime() - lastPlayAt.getTime()) / 3_600_000;
	return h > 72 ? 'danger' : h > 24 ? 'warn' : 'ok';
}

export function suggestedSubtitle(lastSuggestedOn: string | null, today: string, isFollowed: boolean): string {
	if (!lastSuggestedOn) return isFollowed ? 'Play only · followed' : 'Never suggested yet';
	const days = Math.round((Date.parse(today) - Date.parse(lastSuggestedOn)) / 86_400_000);
	return `Last suggested ${days} d ago`;
}

// Hours: API plays have no ms_played, so they count their track length (track_metadata.duration_ms),
// the same fallback as the rollups (migration 0026) and Streamlit (lib/listening_time.py).
export async function loadTiles(sql: Sql): Promise<HomeTiles> {
	const [w] = await sql<{ plays_week: number; ms_week: string; plays_prev: number; month_label: string }[]>`
		WITH b AS (SELECT (date_trunc('week', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam') AS wk)
		SELECT
			count(*) FILTER (WHERE p.played_at >= b.wk)::int AS plays_week,
			coalesce(sum(coalesce(p.ms_played, tm.duration_ms)) FILTER (WHERE p.played_at >= b.wk), 0)::bigint AS ms_week,
			count(*) FILTER (WHERE p.played_at < now() - interval '7 days')::int AS plays_prev,
			to_char(now() AT TIME ZONE 'Europe/Amsterdam', 'Mon') AS month_label
		FROM b LEFT JOIN spotify_plays p ON p.played_at >= b.wk - interval '7 days' AND p.track_uri IS NOT NULL
		LEFT JOIN track_metadata tm ON tm.track_uri = p.track_uri
		GROUP BY b.wk`;
	const days = await sql<{ d: number; plays: number }[]>`
		WITH b AS (SELECT (date_trunc('week', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam') AS wk)
		SELECT ((p.played_at AT TIME ZONE 'Europe/Amsterdam')::date - (b.wk AT TIME ZONE 'Europe/Amsterdam')::date)::int AS d,
			count(*)::int AS plays
		FROM spotify_plays p, b
		WHERE p.played_at >= b.wk AND p.track_uri IS NOT NULL
		GROUP BY 1`;
	const [top] = await sql<{ artist_name: string; plays: number }[]>`
		SELECT artist_name, count(*)::int AS plays FROM spotify_plays
		WHERE played_at >= (date_trunc('month', now() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam')
			AND track_uri IS NOT NULL AND artist_name IS NOT NULL
		GROUP BY artist_name ORDER BY plays DESC, artist_name LIMIT 1`;
	const perDay = Array.from({ length: 7 }, (_, i) => days.find((x) => x.d === i)?.plays ?? 0);
	return {
		playsThisWeek: w?.plays_week ?? 0,
		playsLastWeekSamePoint: w?.plays_prev ?? 0,
		perDay,
		hoursThisWeek: Math.round((Number(w?.ms_week ?? 0) / 3_600_000) * 10) / 10,
		topArtistMonth: top ? { name: top.artist_name, plays: top.plays } : null,
		monthLabel: w?.month_label ?? ''
	};
}

/** hub.home_payload() (migration 0023). Null before 0023 is applied, so Home still renders. */
export async function loadHomeStats(sql: Sql, today: string): Promise<HomeStats | null> {
	try {
		const [r] = await sql<{ p: HomeStats | string }[]>`SELECT hub.home_payload(${today}::date) AS p`;
		const p = r?.p;
		return typeof p === 'string' ? (JSON.parse(p) as HomeStats) : (p ?? null);
	} catch (e) {
		if (isRollupsMissing(e)) return null;
		throw e;
	}
}

export async function homePayload(sql: Sql, opts: { today: string; ownerId: string; reseedAvailable: boolean }): Promise<HomePayload> {
	const [deck, tiles, conns, last, stats, elsewhere, upcoming] = await Promise.all([
		loadDeck(sql, opts.today, opts.reseedAvailable),
		loadTiles(sql),
		connectionStatus(sql),
		sql<{ t: Date | null }[]>`SELECT max(played_at) AS t FROM spotify_plays`,
		loadHomeStats(sql, opts.today),
		countCollections(sql).catch((e) => {
			if (isRollupsMissing(e)) return null; // 0024 not applied yet
			throw e;
		}),
		comingUp(sql, opts.today, 5) // R7: [] before migration 0028
	]);
	const lastPlayAt = last[0]?.t ? new Date(last[0].t) : null;

	const named = await sql<PlRow[]>`
		SELECT playlist_id, name, image_url, managed_kind, is_owned, is_collab, owner_name, track_count
		FROM spotify_playlists
		WHERE removed_at IS NULL AND is_owned AND name IN ${sql([...SHORTCUT_NAMES, ...MISSED_NEW_NAMES])}`;
	const byName = new Map(named.map((r) => [r.name, r]));
	const [latestCustom] = await sql<PlRow[]>`
		SELECT p.playlist_id, p.name, p.image_url, p.managed_kind, p.is_owned, p.is_collab, p.owner_name, p.track_count
		FROM custom_playlists c JOIN spotify_playlists p ON p.playlist_id = c.playlist_id
		WHERE p.removed_at IS NULL ORDER BY c.created_at DESC LIMIT 1`;

	const liked: PlaylistCard = {
		id: null,
		uri: `spotify:user:${opts.ownerId}:collection`,
		name: 'Liked Songs',
		imageUrl: null,
		kind: null,
		isOwned: true,
		isCollab: false,
		ownerName: null,
		trackCount: null,
		subtitle: null,
		virtual: 'liked'
	};
	const shortcuts: PlaylistCard[] = [
		...SHORTCUT_NAMES.map((n) => byName.get(n)).filter((r): r is PlRow => !!r).map((r) => card(r)),
		liked,
		...(latestCustom ? [card(latestCustom)] : [])
	];

	// Fresh: snapshots first seen in the last 7 days (ignoring the mirror's first import)
	// plus the two Missed new tracks playlists.
	const snaps = await sql<(PlRow & { first_seen_at: Date })[]>`
		SELECT playlist_id, name, image_url, managed_kind, is_owned, is_collab, owner_name, track_count, first_seen_at
		FROM spotify_playlists
		WHERE removed_at IS NULL AND managed_kind = 'auto_snapshot'
			AND first_seen_at >= now() - interval '7 days'
			AND first_seen_at > (SELECT min(first_seen_at) + interval '1 hour' FROM spotify_playlists)
		ORDER BY first_seen_at DESC LIMIT 4`;
	const fresh: PlaylistCard[] = [
		...snaps.map((r) => card(r, 'New snapshot')),
		...MISSED_NEW_NAMES.map((n) => byName.get(n)).filter((r): r is PlRow => !!r).map((r) => card(r, 'Unplayed new releases'))
	];

	const rotation = await sql<(PlRow & { last_suggested_on: Date | string | null })[]>`
		SELECT p.playlist_id, p.name, p.image_url, p.managed_kind, p.is_owned, p.is_collab, p.owner_name, p.track_count,
			h.last_suggested_on
		FROM playlist_rotation_history h JOIN spotify_playlists p USING (playlist_id)
		WHERE p.removed_at IS NULL AND h.rotation_score IS NOT NULL
			AND (h.last_suggested_on IS NULL OR h.last_suggested_on < ${opts.today}::date - 30)
			AND p.playlist_id NOT IN (
				SELECT playlist_id FROM daily_pick_candidates WHERE pick_date = ${opts.today} AND playlist_id IS NOT NULL)
		ORDER BY h.rotation_score DESC, p.playlist_id LIMIT 6`;
	const comingBack = rotation.map((r) =>
		card(
			r,
			suggestedSubtitle(
				r.last_suggested_on ? String(r.last_suggested_on instanceof Date ? r.last_suggested_on.toISOString() : r.last_suggested_on).slice(0, 10) : null,
				opts.today,
				!r.is_owned && !r.is_collab
			)
		)
	);

	return {
		generatedAt: new Date().toISOString(),
		health: {
			lastPlayAt: lastPlayAt?.toISOString() ?? null,
			ingest: ingestHealth(lastPlayAt),
			token: conns.hub.health,
			tokenDaysLeft: conns.hub.daysLeft,
			cronTokenDaysLeft: conns.cron.daysLeft
		},
		daily: deck,
		tiles,
		shortcuts,
		fresh,
		comingBack,
		stats,
		elsewhere,
		comingUp: upcoming
	};
}
