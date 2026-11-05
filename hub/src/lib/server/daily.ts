/**
 * Daily pick, hub side. Candidates come from scripts/generate_daily_picks.py; the hub
 * only moves a pointer (Rotate/select: no Spotify call) and plays.
 *
 * Play of a generated pick rewrites 'Daily pick · Auto 🤖🔄' through the write guard
 * and plays it as a context. Play of an existing playlist writes nothing.
 */
import type { Queryable, Sql } from '$lib/server/db';
import type { HubConfig } from '$lib/server/env';
import { DAILY_PICK_DESCRIPTION, DAILY_PICK_PLAYLIST_NAME, type ManagedKind } from '$lib/shared/managed';
import type { DailyCandidate, DailyDeck, DailyState, PlaylistCard, TrackRow } from '$lib/shared/daily-types';
import { SpotifyError, type SpotifyApi } from './spotify/api';
import type { WriteGuard } from './spotify/write-guard';
import { syncMirror, upsertMirrorRow } from './spotify/mirror';
import { enqueueAndDispatch, getJob, jobsAvailable } from './jobs';
import type { JobRow } from '$lib/shared/jobs';

interface CandidateRow {
	pick_date: Date | string;
	rank: number;
	kind: 'generated' | 'existing_playlist';
	recipe: string | null;
	params: Record<string, unknown> | null;
	playlist_id: string | null;
	title: string;
	reason: string;
	track_uris: string[] | null;
	duration_ms: string | number | null;
	p_name: string | null;
	p_image_url: string | null;
	p_track_count: number | null;
	p_is_owned: boolean | null;
	p_is_collab: boolean | null;
	p_owner_name: string | null;
	p_managed_kind: ManagedKind | null;
}

function isoDate(d: Date | string): string {
	return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

export function toCandidate(r: CandidateRow): DailyCandidate {
	const playlist: PlaylistCard | null = r.playlist_id
		? {
				id: r.playlist_id,
				uri: `spotify:playlist:${r.playlist_id}`,
				name: r.p_name ?? r.title,
				imageUrl: r.p_image_url,
				kind: r.p_managed_kind,
				isOwned: !!r.p_is_owned,
				isCollab: !!r.p_is_collab,
				ownerName: r.p_owner_name,
				trackCount: r.p_track_count,
				subtitle: null
			}
		: null;
	return {
		date: isoDate(r.pick_date),
		rank: r.rank,
		kind: r.kind,
		recipe: r.recipe,
		params: r.params ?? {},
		title: r.title,
		reason: r.reason,
		trackCount: r.track_uris ? r.track_uris.length : (r.p_track_count ?? null),
		durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
		playlist
	};
}

/** Next rank after `current`, or null when the deck is exhausted. */
export function nextRank(ranks: number[], current: number): number | null {
	const after = ranks.filter((r) => r > current).sort((a, b) => a - b);
	return after[0] ?? null;
}

async function candidateRows(sql: Queryable, date: string, rank?: number): Promise<CandidateRow[]> {
	return sql<CandidateRow[]>`
		SELECT c.pick_date, c.rank, c.kind, c.recipe, c.params, c.playlist_id, c.title, c.reason, c.track_uris, c.duration_ms,
			p.name AS p_name, p.image_url AS p_image_url, p.track_count AS p_track_count, p.is_owned AS p_is_owned,
			p.is_collab AS p_is_collab, p.owner_name AS p_owner_name, p.managed_kind AS p_managed_kind
		FROM daily_pick_candidates c
		LEFT JOIN spotify_playlists p ON p.playlist_id = c.playlist_id
		WHERE c.pick_date = ${date} ${rank === undefined ? sql`` : sql`AND c.rank = ${rank}`}
		ORDER BY c.rank`;
}

export async function markSuggested(sql: Queryable, playlistId: string, date: string): Promise<void> {
	await sql`
		INSERT INTO playlist_rotation_history AS h (playlist_id, last_suggested_on, times_suggested)
		VALUES (${playlistId}, ${date}, 1)
		ON CONFLICT (playlist_id) DO UPDATE SET
			times_suggested = h.times_suggested + CASE WHEN h.last_suggested_on IS DISTINCT FROM EXCLUDED.last_suggested_on THEN 1 ELSE 0 END,
			last_suggested_on = EXCLUDED.last_suggested_on`;
}

function toState(r: {
	current_rank: number;
	played_rank: number | null;
	played_at: Date | null;
	rotated: number[] | null;
	reseed_requested_at: Date | null;
}): DailyState {
	return {
		currentRank: r.current_rank,
		playedRank: r.played_rank,
		playedAt: r.played_at ? new Date(r.played_at).toISOString() : null,
		rotated: r.rotated ?? [],
		reseedRequestedAt: r.reseed_requested_at ? new Date(r.reseed_requested_at).toISOString() : null
	};
}

export async function findDailyPickPlaylistId(sql: Queryable): Promise<string | null> {
	const [r] = await sql<{ playlist_id: string }[]>`
		SELECT playlist_id FROM spotify_playlists
		WHERE name = ${DAILY_PICK_PLAYLIST_NAME} AND is_owned AND removed_at IS NULL
		ORDER BY first_seen_at LIMIT 1`;
	return r?.playlist_id ?? null;
}

/** Today's deck. The first view of a day creates the state row and counts as "suggested". */
export async function loadDeck(sql: Sql, date: string, reseedAvailable: boolean): Promise<DailyDeck> {
	const rows = await candidateRows(sql, date);
	const candidates = rows.map(toCandidate);
	let state: DailyState | null = null;
	if (candidates.length) {
		const first = candidates[0]!.rank;
		const created = await sql<{ pick_date: Date }[]>`
			INSERT INTO daily_pick_state (pick_date, current_rank) VALUES (${date}, ${first})
			ON CONFLICT (pick_date) DO NOTHING RETURNING pick_date`;
		const [s] = await sql<Parameters<typeof toState>[0][]>`
			SELECT current_rank, played_rank, played_at, rotated, reseed_requested_at FROM daily_pick_state WHERE pick_date = ${date}`;
		state = s ? toState(s) : null;
		const cur = candidates.find((c) => c.rank === state?.currentRank) ?? candidates[0]!;
		if (created.length && cur.playlist?.id) await markSuggested(sql, cur.playlist.id, date);
	}
	const current = candidates.find((c) => c.rank === state?.currentRank) ?? candidates[0] ?? null;
	const dailyId = await findDailyPickPlaylistId(sql);
	const [rj] = await sql<{ id: string }[]>`
		SELECT id FROM hub_jobs WHERE kind = 'reseed_daily_pick' AND payload->>'date' = ${date}
		ORDER BY requested_at DESC LIMIT 1`;
	return {
		date,
		candidates,
		state,
		current,
		dailyPlaylistUri: dailyId ? `spotify:playlist:${dailyId}` : null,
		reseedAvailable,
		reseedJob: rj ? await getJob(sql, rj.id) : null
	};
}

export type MoveResult = { ok: true } | { ok: false; reason: 'exhausted' | 'stale' | 'unknown_rank' | 'no_deck' };

/** Rotate: idempotent per `fromRank`, so a double tap moves once. No Spotify call. */
export async function rotate(sql: Sql, date: string, fromRank: number): Promise<MoveResult> {
	return sql.begin(async (tx) => {
		const [s] = await tx<{ current_rank: number }[]>`
			SELECT current_rank FROM daily_pick_state WHERE pick_date = ${date} FOR UPDATE`;
		if (!s) return { ok: false, reason: 'no_deck' } as const;
		if (s.current_rank !== fromRank) return { ok: false, reason: 'stale' } as const;
		const ranks = (await tx<{ rank: number }[]>`SELECT rank FROM daily_pick_candidates WHERE pick_date = ${date}`).map((r) => r.rank);
		const next = nextRank(ranks, fromRank);
		if (next === null) return { ok: false, reason: 'exhausted' } as const;
		await tx`
			UPDATE daily_pick_state SET current_rank = ${next}, rotated = array_append(rotated, ${fromRank}::smallint), updated_at = now()
			WHERE pick_date = ${date}`;
		const [c] = await tx<{ playlist_id: string | null }[]>`
			SELECT playlist_id FROM daily_pick_candidates WHERE pick_date = ${date} AND rank = ${next}`;
		if (c?.playlist_id) await markSuggested(tx, c.playlist_id, date);
		return { ok: true } as const;
	});
}

/** Make any candidate of the day current ("Other candidates today", or start over). */
export async function select(sql: Sql, date: string, rank: number): Promise<MoveResult> {
	return sql.begin(async (tx) => {
		const [c] = await tx<{ playlist_id: string | null }[]>`
			SELECT playlist_id FROM daily_pick_candidates WHERE pick_date = ${date} AND rank = ${rank}`;
		if (!c) return { ok: false, reason: 'unknown_rank' } as const;
		await tx`
			INSERT INTO daily_pick_state (pick_date, current_rank) VALUES (${date}, ${rank})
			ON CONFLICT (pick_date) DO UPDATE SET current_rank = EXCLUDED.current_rank, updated_at = now()`;
		if (c.playlist_id) await markSuggested(tx, c.playlist_id, date);
		return { ok: true } as const;
	});
}

export async function markPlayed(sql: Queryable, date: string, rank: number, playlistId: string | null): Promise<void> {
	await sql`
		UPDATE daily_pick_state SET played_rank = ${rank}, played_at = now(), updated_at = now() WHERE pick_date = ${date}`;
	if (playlistId) {
		await sql`
			INSERT INTO playlist_rotation_history AS h (playlist_id, last_played_on, times_played)
			VALUES (${playlistId}, ${date}, 1)
			ON CONFLICT (playlist_id) DO UPDATE SET
				times_played = h.times_played + CASE WHEN h.last_played_on IS DISTINCT FROM EXCLUDED.last_played_on THEN 1 ELSE 0 END,
				last_played_on = EXCLUDED.last_played_on`;
	}
}

/** Names + your play counts for a generated pick (names verbatim from your own plays / the mirror). */
export async function generatedTrackRows(sql: Queryable, uris: string[]): Promise<TrackRow[]> {
	if (!uris.length) return [];
	const rows = await sql<{ uri: string; name: string | null; artist: string | null; duration_ms: number | null; plays: number }[]>`
		WITH u AS (SELECT uri, ord FROM unnest(${uris}::text[]) WITH ORDINALITY AS t(uri, ord))
		SELECT u.uri,
			coalesce(sp.track_name, mi.track_name) AS name,
			coalesce(sp.artist_name, mi.artist_name) AS artist,
			coalesce(tm.duration_ms, mi.duration_ms) AS duration_ms,
			coalesce(pc.plays, 0)::int AS plays
		FROM u
		LEFT JOIN LATERAL (SELECT track_name, artist_name FROM spotify_plays WHERE track_uri = u.uri ORDER BY played_at DESC LIMIT 1) sp ON true
		LEFT JOIN LATERAL (SELECT track_name, artist_name, duration_ms FROM spotify_playlist_items WHERE track_uri = u.uri LIMIT 1) mi ON true
		LEFT JOIN track_metadata tm ON tm.track_uri = u.uri
		LEFT JOIN LATERAL (SELECT count(*) AS plays FROM spotify_plays WHERE track_uri = u.uri) pc ON true
		ORDER BY u.ord`;
	return rows.map((r) => ({ uri: r.uri, name: r.name, artist: r.artist, durationMs: r.duration_ms, plays: r.plays }));
}

/** Items of an owned/collab playlist from the mirror; empty for followed playlists. */
export async function playlistTrackRows(sql: Queryable, playlistId: string): Promise<TrackRow[]> {
	const rows = await sql<{ uri: string; name: string | null; artist: string | null; duration_ms: number | null; plays: number }[]>`
		SELECT i.track_uri AS uri, i.track_name AS name, i.artist_name AS artist, i.duration_ms,
			coalesce(pc.plays, 0)::int AS plays
		FROM spotify_playlist_items i
		LEFT JOIN LATERAL (SELECT count(*) AS plays FROM spotify_plays WHERE track_uri = i.track_uri) pc ON true
		WHERE i.playlist_id = ${playlistId}
		ORDER BY i.position
		LIMIT 500`;
	return rows.map((r) => ({ uri: r.uri, name: r.name, artist: r.artist, durationMs: r.duration_ms, plays: r.plays }));
}

export interface PlayDeps {
	sql: Sql;
	api: SpotifyApi;
	guard: WriteGuard;
	ownerId: string;
}

/** Find the Daily pick playlist (mirror → fresh mirror sync → create). */
export async function ensureDailyPickPlaylist(deps: PlayDeps): Promise<string> {
	const known = await findDailyPickPlaylistId(deps.sql);
	if (known) return known;
	await syncMirror(deps.sql, deps.api, deps.ownerId, true);
	const synced = await findDailyPickPlaylistId(deps.sql);
	if (synced) return synced;
	const created = await deps.guard.createManagedPlaylist({
		name: DAILY_PICK_PLAYLIST_NAME,
		description: DAILY_PICK_DESCRIPTION,
		public: false
	});
	const [clock] = await deps.sql<{ now: Date }[]>`SELECT now() AS now`;
	await upsertMirrorRow(
		deps.sql,
		{
			playlist_id: created.id,
			name: created.name,
			owner_id: deps.ownerId,
			owner_name: null,
			is_owned: true,
			is_collab: false,
			is_public: false,
			managed_kind: created.kind,
			snapshot_id: null,
			track_count: 0,
			image_url: null
		},
		clock!.now
	);
	return created.id;
}

export interface PlayResult {
	contextUri: string;
	wrote: boolean;
}

export async function playCandidate(
	deps: PlayDeps,
	input: { date: string; rank: number; deviceId: string | null; offset?: number }
): Promise<PlayResult> {
	const [row] = await candidateRows(deps.sql, input.date, input.rank);
	if (!row) throw new SpotifyError(404, 'UNKNOWN_CANDIDATE', 'No such candidate');
	let contextUri: string;
	let wrote = false;
	if (row.kind === 'generated') {
		let id = await ensureDailyPickPlaylist(deps);
		try {
			await deps.guard.replaceItems(id, row.track_uris ?? []);
		} catch (e) {
			// Deleted in Spotify since the last mirror sync: forget it and create/find again once.
			if (!(e instanceof SpotifyError && e.status === 404)) throw e;
			await deps.sql`UPDATE spotify_playlists SET removed_at = now() WHERE playlist_id = ${id}`;
			id = await ensureDailyPickPlaylist(deps);
			await deps.guard.replaceItems(id, row.track_uris ?? []);
		}
		contextUri = `spotify:playlist:${id}`;
		wrote = true;
	} else {
		contextUri = `spotify:playlist:${row.playlist_id}`;
	}
	await deps.api.request('PUT', '/me/player/play', {
		query: input.deviceId ? { device_id: input.deviceId } : undefined,
		body: { context_uri: contextUri, offset: { position: input.offset ?? 0 } }
	});
	await markPlayed(deps.sql, input.date, input.rank, row.kind === 'existing_playlist' ? row.playlist_id : null);
	return { contextUri, wrote };
}

export type ReseedResult = { mode: 'job'; job: JobRow } | { mode: 'wrap'; rank: number };

/**
 * "Shuffle the deck" (R2): a reseed_daily_pick job, run by Python via hub-jobs.yml (~1 min).
 * One active job per day (dedupe_key), so a double tap doesn't mix twice. Without
 * GITHUB_DISPATCH_TOKEN there is no job runner: the deck starts over at its first pick.
 */
export async function requestReseed(
	sql: Sql,
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	date: string,
	f: typeof fetch = fetch
): Promise<ReseedResult> {
	if (!jobsAvailable(cfg)) {
		const [r] = await sql<{ rank: number }[]>`SELECT min(rank)::int AS rank FROM daily_pick_candidates WHERE pick_date = ${date}`;
		const rank = r?.rank ?? 1;
		await select(sql, date, rank);
		return { mode: 'wrap', rank };
	}
	const { job } = await enqueueAndDispatch(sql, cfg, 'reseed_daily_pick', { date }, `reseed:${date}`, f);
	return { mode: 'job', job };
}
