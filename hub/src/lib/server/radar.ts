/**
 * Release radar, server side (R7). Reads what the daily Python run wrote (migration 0028).
 *
 *   loadRadar()          Coming up (date > today, soonest first) + Recently out (last 60 days),
 *                        artist filter, source health.
 *   comingUp()           the Home shelf: next announced releases.
 *   follow()/unfollow()  "Follow in Rotor" (radar_followed_artists). Never a Spotify follow.
 *   updatePlaylist()     rewrites "New from your artists · Auto 🤖🔄" (write guard, requireKind
 *                        auto_updating) with the Spotify releases of the last 14 days.
 */
import type { Queryable } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';
import {
	RADAR_PLAYLIST_DAYS,
	RADAR_PLAYLIST_DESCRIPTION,
	RADAR_PLAYLIST_NAME,
	RADAR_RECENT_DAYS,
	radarStatus,
	type RadarPayload,
	type RadarRelease,
	type RadarSource,
	type RadarSourceHealth
} from '$lib/shared/radar';
import { writeManagedPlaylist, type ManagedPlaylistDeps } from './managed-playlist';

interface Row {
	id: string;
	artist_name: string;
	artist_id: string | null;
	title: string;
	release_date: string | null;
	date_precision: RadarRelease['precision'];
	release_type: string | null;
	label: string | null;
	spotify_url: string | null;
	url: string | null;
	sources: RadarSource[];
	in_library: boolean;
	followed: boolean;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

function toRelease(r: Row, today: string): RadarRelease {
	return {
		id: Number(r.id),
		artist: r.artist_name,
		artistId: r.artist_id,
		title: r.title,
		date: r.release_date,
		precision: r.date_precision,
		type: r.release_type,
		label: r.label,
		spotifyUrl: r.spotify_url,
		url: r.url,
		sources: r.sources ?? [],
		status: radarStatus(r.release_date, r.in_library, today),
		followed: r.followed
	};
}

async function rows(sql: Queryable, where: 'upcoming' | 'recent', today: string, artist: string | null, followedOnly: boolean, limit: number): Promise<Row[]> {
	return sql<Row[]>`
		SELECT r.id, r.artist_name, r.artist_id, r.title, to_char(r.release_date, 'YYYY-MM-DD') AS release_date, r.date_precision,
		       r.release_type, r.label, r.spotify_url,
		       (SELECT s.url FROM radar_release_sources s WHERE s.release_id = r.id AND s.url IS NOT NULL
		        ORDER BY (s.source = 'spotify') DESC, (s.source = 'scantraxx') DESC LIMIT 1) AS url,
		       (SELECT array_agg(DISTINCT s.source ORDER BY s.source) FROM radar_release_sources s WHERE s.release_id = r.id) AS sources,
		       r.in_library,
		       EXISTS (SELECT 1 FROM radar_followed_artists f WHERE f.artist_id = r.artist_id) AS followed
		FROM radar_releases r
		WHERE ${where === 'upcoming' ? sql`r.release_date > ${today}::date` : sql`r.release_date <= ${today}::date AND r.release_date >= ${today}::date - ${RADAR_RECENT_DAYS}::int`}
		  AND (${artist}::text IS NULL OR r.artist_key = ${artist}::text)
		  AND (NOT ${followedOnly} OR EXISTS (SELECT 1 FROM radar_followed_artists f WHERE f.artist_id = r.artist_id))
		ORDER BY ${where === 'upcoming' ? sql`r.release_date ASC, r.artist_name, r.title` : sql`r.release_date DESC, r.artist_name, r.title`}
		LIMIT ${limit}`;
}

export async function loadRadar(sql: Queryable, today: string, opts: { artist?: string | null; followedOnly?: boolean } = {}): Promise<RadarPayload> {
	const artist = opts.artist ? opts.artist : null;
	const followedOnly = !!opts.followedOnly;
	const [upcoming, recent, artists, sources, [meta]] = await Promise.all([
		rows(sql, 'upcoming', today, artist, followedOnly, 200),
		rows(sql, 'recent', today, artist, followedOnly, 200),
		sql<{ key: string; name: string; count: number }[]>`
			SELECT artist_key AS key, max(artist_name) AS name, count(*)::int AS count FROM radar_releases
			WHERE release_date >= ${today}::date - ${RADAR_RECENT_DAYS}::int
			GROUP BY artist_key ORDER BY count DESC, name LIMIT 60`,
		sql<{
			source: RadarSource;
			enabled: boolean;
			disabled_reason: string | null;
			last_run_at: Date | null;
			last_success_at: Date | null;
			last_error: string | null;
			last_error_at: Date | null;
			failing_since: string | null;
			consecutive_failures: number;
			last_items: number | null;
		}[]>`SELECT source, enabled, disabled_reason, last_run_at, last_success_at, last_error, last_error_at,
		            to_char(failing_since, 'YYYY-MM-DD') AS failing_since, consecutive_failures, last_items
		     FROM radar_sources ORDER BY array_position(ARRAY['spotify','musicbrainz','scantraxx'], source)`,
		sql<{ followed: number; last_run: Date | null; tracks: number }[]>`
			SELECT (SELECT count(*)::int FROM radar_followed_artists) AS followed,
			       (SELECT max(ran_at) FROM radar_runs) AS last_run,
			       (SELECT coalesce(sum(cardinality(track_uris)), 0)::int FROM radar_releases
			        WHERE spotify_album_id IS NOT NULL AND release_date BETWEEN ${today}::date - ${RADAR_PLAYLIST_DAYS}::int AND ${today}::date) AS tracks`
	]);
	return {
		today,
		upcoming: upcoming.map((r) => toRelease(r, today)),
		recent: recent.map((r) => toRelease(r, today)),
		artists: artists.map((a) => ({ key: a.key, name: a.name, count: a.count })),
		sources: sources.map(
			(s): RadarSourceHealth => ({
				source: s.source,
				enabled: s.enabled,
				disabledReason: s.disabled_reason,
				lastRunAt: iso(s.last_run_at),
				lastSuccessAt: iso(s.last_success_at),
				lastError: s.last_error,
				lastErrorAt: iso(s.last_error_at),
				failingSince: s.failing_since,
				consecutiveFailures: s.consecutive_failures,
				lastItems: s.last_items
			})
		),
		followedCount: meta?.followed ?? 0,
		lastRunAt: iso(meta?.last_run ?? null),
		playlistTracks: meta?.tracks ?? 0
	};
}

/** Home "Coming up": the next announced releases. Empty before migration 0028. */
export async function comingUp(sql: Queryable, today: string, limit = 5): Promise<RadarRelease[]> {
	try {
		return (await rows(sql, 'upcoming', today, null, false, limit)).map((r) => toRelease(r, today));
	} catch (e) {
		if ((e as { code?: string })?.code === '42P01') return [];
		throw e;
	}
}

const ARTIST_ID = /^[A-Za-z0-9]{22}$/;

export async function isFollowed(sql: Queryable, artistId: string): Promise<boolean> {
	if (!ARTIST_ID.test(artistId)) throw new BadInput('Not a Spotify artist id');
	const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM radar_followed_artists WHERE artist_id = ${artistId}`;
	return (r?.n ?? 0) > 0;
}

export async function follow(sql: Queryable, artistId: string, name: string): Promise<void> {
	if (!ARTIST_ID.test(artistId)) throw new BadInput('Not a Spotify artist id');
	const clean = name.trim().slice(0, 200);
	if (!clean) throw new BadInput('An artist name is required');
	await sql`INSERT INTO radar_followed_artists (artist_id, name) VALUES (${artistId}, ${clean})
		ON CONFLICT (artist_id) DO UPDATE SET name = EXCLUDED.name`;
}

export async function unfollow(sql: Queryable, artistId: string): Promise<void> {
	if (!ARTIST_ID.test(artistId)) throw new BadInput('Not a Spotify artist id');
	await sql`DELETE FROM radar_followed_artists WHERE artist_id = ${artistId}`;
}

export async function playlistUris(sql: Queryable, today: string): Promise<string[]> {
	const rs = await sql<{ track_uris: string[] }[]>`
		SELECT track_uris FROM radar_releases
		WHERE spotify_album_id IS NOT NULL AND cardinality(track_uris) > 0
		  AND release_date BETWEEN ${today}::date - ${RADAR_PLAYLIST_DAYS}::int AND ${today}::date
		ORDER BY release_date DESC, artist_name, title`;
	const out: string[] = [];
	for (const r of rs) for (const u of r.track_uris) if (/^spotify:track:[A-Za-z0-9]{22}$/.test(u) && !out.includes(u)) out.push(u);
	return out.slice(0, 500);
}

/** "Update playlist": guarded rewrite of the one radar playlist. */
export async function updatePlaylist(deps: ManagedPlaylistDeps, today: string): Promise<{ playlistId: string; name: string; trackCount: number; created: boolean }> {
	const uris = await playlistUris(deps.sql, today);
	if (!uris.length) throw new BadInput('No Spotify releases from your artists in the last 14 days');
	const t = await writeManagedPlaylist(deps, { name: RADAR_PLAYLIST_NAME, description: RADAR_PLAYLIST_DESCRIPTION, uris, kind: 'auto_updating' });
	return { playlistId: t.id, name: RADAR_PLAYLIST_NAME, trackCount: uris.length, created: t.created };
}
