/**
 * Custom 🎧 playlists in Rotor (R2, 03-ux-ia.md flow d). Every Spotify write goes through
 * the write guard with requireKind 'custom'; the selection is the shared SQL function
 * hub.custom_playlist_preview() (migration 0022), so Rotor and Streamlit pick the same tracks.
 */
import type { Queryable, Sql } from '$lib/server/db';
import {
	BadInput,
	customFullName,
	expiresFor,
	filtersSummary,
	parseFilters,
	type CustomFilters,
	type Lifetime
} from '$lib/shared/custom';
import { managedKind } from '$lib/shared/managed';
import { ReadOnlyPlaylist, type WriteGuard } from './spotify/write-guard';
import { upsertMirrorRow } from './spotify/mirror';

export interface PreviewTrack {
	uri: string;
	name: string | null;
	artist: string | null;
	album: string | null;
	plays: number;
	firstPlayedAt: string | null;
	releaseYear: number | null;
}

interface PreviewRow {
	track_uri: string;
	track_name: string | null;
	artist_name: string | null;
	album_name: string | null;
	plays: string | number;
	first_played_at: Date | null;
	release_year: number | null;
}

const PLAYABLE = /^spotify:track:[A-Za-z0-9]{22}$/;

export async function preview(sql: Queryable, f: CustomFilters): Promise<PreviewTrack[]> {
	const rows = await sql<PreviewRow[]>`SELECT * FROM hub.custom_playlist_preview(${JSON.stringify(f)}::text::jsonb)`;
	return rows.map((r) => ({
		uri: r.track_uri,
		name: r.track_name,
		artist: r.artist_name,
		album: r.album_name,
		plays: Number(r.plays),
		firstPlayedAt: r.first_played_at ? new Date(r.first_played_at).toISOString() : null,
		releaseYear: r.release_year
	}));
}

/** How many tracks match, ignoring Max tracks (the "212 tracks match" line). */
export async function countMatches(sql: Queryable, f: CustomFilters): Promise<number> {
	const all = { ...f, max_tracks: 10_000, sort_order: 'plays_desc' as const };
	const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hub.custom_playlist_preview(${JSON.stringify(all)}::text::jsonb)`;
	return r?.n ?? 0;
}

export async function searchArtists(sql: Queryable, q: string, limit = 12): Promise<{ name: string; plays: number }[]> {
	const term = q.trim();
	if (term.length < 2) return [];
	const rows = await sql<{ artist_name: string; plays: number }[]>`
		SELECT artist_name, count(*)::int AS plays FROM spotify_plays
		WHERE track_uri IS NOT NULL AND artist_name ILIKE ${'%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}
		GROUP BY artist_name ORDER BY plays DESC LIMIT ${limit}`;
	return rows.map((r) => ({ name: r.artist_name, plays: r.plays }));
}

function description(summary: string, expiresAt: Date | null): string {
	const tail = expiresAt
		? `Auto-delete on ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC unless you keep it in Rotor.`
		: 'Kept until you delete it.';
	return `Custom playlist made in Rotor. Filters: ${summary}. ${tail}`.slice(0, 300);
}

/** The track list a custom playlist gets: preview minus the tracks you removed. */
export async function selectTracks(sql: Queryable, f: CustomFilters, excluded: string[]): Promise<string[]> {
	const skip = new Set(excluded);
	return (await preview(sql, f)).map((t) => t.uri).filter((u) => PLAYABLE.test(u) && !skip.has(u));
}

export function parseExcluded(v: unknown): string[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.length > 10_000) throw new BadInput('excluded must be a list of track URIs');
	return [...new Set(v.filter((u): u is string => typeof u === 'string' && PLAYABLE.test(u)))];
}

export interface CustomDeps {
	sql: Sql;
	guard: WriteGuard;
	ownerId: string;
}

export interface CreatedCustom {
	playlistId: string;
	name: string;
	trackCount: number;
	expiresAt: string | null;
}

export async function createCustom(
	deps: CustomDeps,
	input: { name: string; filters: CustomFilters; excluded: string[]; lifetime: Lifetime }
): Promise<CreatedCustom> {
	const tracks = await selectTracks(deps.sql, input.filters, input.excluded);
	if (!tracks.length) throw new BadInput('No tracks match these filters');
	const fullName = customFullName(input.name);
	const expiresAt = expiresFor(input.lifetime);
	const summary = filtersSummary(input.filters);
	const created = await deps.guard.createManagedPlaylist({ name: fullName, description: description(summary, expiresAt), public: false });

	// Record it before adding tracks: if adding fails, the sweep / Delete can still find it.
	await deps.sql`
		INSERT INTO custom_playlists (playlist_id, name, expires_at, track_count, filters_summary, filters_json, excluded_uris)
		VALUES (${created.id}, ${fullName}, ${expiresAt}, 0, ${summary}, ${JSON.stringify(input.filters)}::text::jsonb, ${input.excluded})`;
	const [clock] = await deps.sql<{ now: Date }[]>`SELECT now() AS now`;
	await upsertMirrorRow(
		deps.sql,
		{
			playlist_id: created.id,
			name: fullName,
			owner_id: deps.ownerId,
			owner_name: null,
			is_owned: true,
			is_collab: false,
			is_public: false,
			managed_kind: 'custom',
			snapshot_id: null,
			track_count: 0,
			image_url: null
		},
		clock!.now
	);
	await deps.guard.addItems(created.id, tracks, undefined, { requireKind: 'custom' });
	await deps.sql`UPDATE custom_playlists SET track_count = ${tracks.length} WHERE playlist_id = ${created.id}`;
	await deps.sql`UPDATE spotify_playlists SET track_count = ${tracks.length} WHERE playlist_id = ${created.id}`;
	return { playlistId: created.id, name: fullName, trackCount: tracks.length, expiresAt: expiresAt?.toISOString() ?? null };
}

/**
 * "Save as custom playlist" from a Stats list or detail page (R3): an explicit track list
 * instead of filters. Same guarded path as createCustom (create with the Custom suffix, then
 * guarded add with requireKind custom); filters_json stays NULL, so Edit starts from defaults.
 */
export async function createCustomFromTracks(
	deps: CustomDeps,
	input: { name: string; uris: string[]; lifetime: Lifetime; source: string }
): Promise<CreatedCustom> {
	const tracks = [...new Set(input.uris.filter((u) => PLAYABLE.test(u)))].slice(0, 500);
	if (!tracks.length) throw new BadInput('No playable tracks in this list');
	const fullName = customFullName(input.name);
	const expiresAt = expiresFor(input.lifetime);
	const summary = `from ${input.source.slice(0, 120)}`;
	const created = await deps.guard.createManagedPlaylist({ name: fullName, description: description(summary, expiresAt), public: false });
	await deps.sql`
		INSERT INTO custom_playlists (playlist_id, name, expires_at, track_count, filters_summary, filters_json, excluded_uris)
		VALUES (${created.id}, ${fullName}, ${expiresAt}, 0, ${summary}, NULL, ${[]})`;
	const [clock] = await deps.sql<{ now: Date }[]>`SELECT now() AS now`;
	await upsertMirrorRow(
		deps.sql,
		{
			playlist_id: created.id,
			name: fullName,
			owner_id: deps.ownerId,
			owner_name: null,
			is_owned: true,
			is_collab: false,
			is_public: false,
			managed_kind: 'custom',
			snapshot_id: null,
			track_count: 0,
			image_url: null
		},
		clock!.now
	);
	await deps.guard.addItems(created.id, tracks, undefined, { requireKind: 'custom' });
	await deps.sql`UPDATE custom_playlists SET track_count = ${tracks.length} WHERE playlist_id = ${created.id}`;
	await deps.sql`UPDATE spotify_playlists SET track_count = ${tracks.length} WHERE playlist_id = ${created.id}`;
	return { playlistId: created.id, name: fullName, trackCount: tracks.length, expiresAt: expiresAt?.toISOString() ?? null };
}

interface CustomRow {
	playlist_id: string;
	name: string;
	created_at: Date;
	expires_at: Date | null;
	track_count: number;
	filters_summary: string | null;
	filters_json: unknown;
	excluded_uris: string[] | null;
}

export interface CustomState {
	playlistId: string;
	name: string;
	createdAt: string;
	expiresAt: string | null;
	trackCount: number;
	filtersSummary: string | null;
	filters: CustomFilters | null;
	excluded: string[];
}

export async function getCustom(sql: Queryable, playlistId: string): Promise<CustomState | null> {
	const [r] = await sql<CustomRow[]>`SELECT * FROM custom_playlists WHERE playlist_id = ${playlistId}`;
	if (!r) return null;
	let filters: CustomFilters | null = null;
	try {
		filters = r.filters_json ? parseFilters(r.filters_json) : null;
	} catch {
		filters = null;
	}
	return {
		playlistId: r.playlist_id,
		name: r.name,
		createdAt: new Date(r.created_at).toISOString(),
		expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
		trackCount: r.track_count,
		filtersSummary: r.filters_summary,
		filters,
		excluded: r.excluded_uris ?? []
	};
}

/** DB-only actions (extend/keep) still need a Custom 🎧 row: anything else is read-only (403). */
export async function requireCustom(sql: Queryable, playlistId: string): Promise<CustomState> {
	const row = await getCustom(sql, playlistId);
	if (row && managedKind(row.name) === 'custom') return row;
	throw new ReadOnlyPlaylist(playlistId, 'not_custom');
}

export async function updateCustom(
	deps: CustomDeps,
	playlistId: string,
	input: { filters: CustomFilters; excluded: string[] }
): Promise<{ trackCount: number }> {
	await requireCustom(deps.sql, playlistId);
	const tracks = await selectTracks(deps.sql, input.filters, input.excluded);
	if (!tracks.length) throw new BadInput('No tracks match these filters');
	await deps.guard.replaceItems(playlistId, tracks, { requireKind: 'custom' });
	await deps.sql`
		UPDATE custom_playlists SET filters_json = ${JSON.stringify(input.filters)}::text::jsonb, excluded_uris = ${input.excluded},
			track_count = ${tracks.length}, filters_summary = ${filtersSummary(input.filters)}
		WHERE playlist_id = ${playlistId}`;
	await deps.sql`UPDATE spotify_playlists SET track_count = ${tracks.length} WHERE playlist_id = ${playlistId}`;
	return { trackCount: tracks.length };
}

/** Same SQL as Streamlit's "Extend +7 days". */
export async function extendCustom(sql: Queryable, playlistId: string): Promise<string | null> {
	await requireCustom(sql, playlistId);
	const [r] = await sql<{ expires_at: Date }[]>`
		UPDATE custom_playlists SET expires_at = COALESCE(expires_at, now()) + interval '7 days'
		WHERE playlist_id = ${playlistId} RETURNING expires_at`;
	return r ? new Date(r.expires_at).toISOString() : null;
}

/** Same SQL as Streamlit's "Make permanent". */
export async function keepCustom(sql: Queryable, playlistId: string): Promise<void> {
	await requireCustom(sql, playlistId);
	await sql`UPDATE custom_playlists SET expires_at = NULL WHERE playlist_id = ${playlistId}`;
}

/** Remove from Spotify (guarded unfollow) then from the DB. A Spotify failure keeps the row. */
export async function deleteCustom(deps: CustomDeps, playlistId: string): Promise<void> {
	await deps.guard.unfollowCustom(playlistId);
	await deps.sql`DELETE FROM custom_playlists WHERE playlist_id = ${playlistId}`;
	await deps.sql`UPDATE spotify_playlists SET removed_at = now() WHERE playlist_id = ${playlistId}`;
}
