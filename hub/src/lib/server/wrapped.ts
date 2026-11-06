/**
 * Rotor Wrapped, server side (R6). Reads hub.wrapped_payload() / wrapped_snapshots (migration 0027).
 *
 *   listYears()      2017 → this year with status: so_far (this year) · frozen · buildable.
 *   loadWrapped()    this year: live payload through today; past years: the frozen snapshot only
 *                    (null until built: a past year is never computed live, so it can't drift).
 *   requestBuild()   a wrapped_build hub job (dedupe per year); without GITHUB_DISPATCH_TOKEN the
 *                    hub freezes the year itself with the same SQL function.
 *   playTop100()     rewrites "Wrapped <year> · Auto 🤖📸" (write guard, requireKind auto_snapshot)
 *                    with the year's top 100 and plays it. Never touches any other playlist.
 */
import type { Queryable } from '$lib/server/db';
import type { HubConfig } from '$lib/server/env';
import { BadInput } from '$lib/shared/custom';
import type { JobRow } from '$lib/shared/jobs';
import {
	isWrappedYear,
	topUris,
	wrappedPlaylistName,
	wrappedYears,
	type WrappedPayload,
	type WrappedResponse,
	type WrappedYear
} from '$lib/shared/wrapped';
import { enqueueAndDispatch, jobsAvailable } from './jobs';
import { writeManagedPlaylist, type ManagedPlaylistDeps } from './managed-playlist';

export async function listYears(sql: Queryable, today: string): Promise<WrappedYear[]> {
	const rows = await sql<{ year: number; generated_at: Date }[]>`SELECT year, generated_at FROM wrapped_snapshots`;
	const frozen = new Map(rows.map((r) => [Number(r.year), new Date(r.generated_at).toISOString()]));
	const thisYear = Number(today.slice(0, 4));
	return wrappedYears(today).map((year) => ({
		year,
		status: year === thisYear ? 'so_far' : frozen.has(year) ? 'frozen' : 'buildable',
		generatedAt: frozen.get(year) ?? null
	}));
}

export async function loadWrapped(sql: Queryable, year: number, today: string): Promise<WrappedResponse | null> {
	if (!isWrappedYear(year, today)) throw new BadInput(`No Rotor Wrapped for ${year}`);
	const playlistName = wrappedPlaylistName(year);
	if (year === Number(today.slice(0, 4))) {
		const [r] = await sql<{ p: WrappedPayload }[]>`SELECT hub.wrapped_payload(${year}::int, ${today}::date) AS p`;
		return { mode: 'so_far', payload: r!.p, playlistName };
	}
	const [r] = await sql<{ payload: WrappedPayload }[]>`SELECT payload FROM wrapped_snapshots WHERE year = ${year}`;
	return r ? { mode: 'frozen', payload: r.payload, playlistName } : null;
}

export type BuildResult =
	| { mode: 'job'; job: JobRow }
	| { mode: 'inline'; result: { year: number; created: boolean; generatedAt: string; buildMs: number } };

export async function requestBuild(
	sql: Queryable,
	cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>,
	year: number,
	today: string
): Promise<BuildResult> {
	if (!isWrappedYear(year, today) || year >= Number(today.slice(0, 4))) throw new BadInput(`${year} can't be frozen yet`);
	if (jobsAvailable(cfg)) {
		const { job } = await enqueueAndDispatch(sql, cfg, 'wrapped_build', { year }, `wrapped:${year}`);
		return { mode: 'job', job };
	}
	const [r] = await sql<{ r: { year: number; created: boolean; generatedAt: string; buildMs: number } }[]>`
		SELECT hub.wrapped_freeze(${year}::int, 'hub') AS r`;
	return { mode: 'inline', result: r!.r };
}

export interface PlayTopResult {
	playlistId: string;
	name: string;
	trackCount: number;
	created: boolean;
	contextUri: string;
}

export async function playTop100(
	deps: ManagedPlaylistDeps,
	input: { year: number; today: string; deviceId: string | null }
): Promise<PlayTopResult> {
	const w = await loadWrapped(deps.sql, input.year, input.today);
	if (!w) throw new BadInput(`Rotor Wrapped ${input.year} isn't built yet`);
	const uris = topUris(w.payload, 100);
	if (!uris.length) throw new BadInput(`No playable tracks in Rotor Wrapped ${input.year}`);
	const name = wrappedPlaylistName(input.year);
	const description = `Your top ${uris.length} of ${input.year}${w.mode === 'so_far' ? ' so far' : ''}, from Rotor Wrapped. Rewritten when you press "Play your top 100" in Rotor; manual edits are overwritten.`;
	const target = await writeManagedPlaylist(deps, { name, description, uris, kind: 'auto_snapshot' });
	const contextUri = `spotify:playlist:${target.id}`;
	await deps.api.request('PUT', '/me/player/play', {
		query: input.deviceId ? { device_id: input.deviceId } : undefined,
		body: { context_uri: contextUri, offset: { position: 0 } }
	});
	return { playlistId: target.id, name, trackCount: uris.length, created: target.created, contextUri };
}
