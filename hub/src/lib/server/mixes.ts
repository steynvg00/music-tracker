/**
 * Mixed sessions (R5, experimental, opt-in per device). Mixes are a separate list type in
 * Elsewhere; nothing here writes to Spotify playlists (playback only goes through the
 * existing player proxy), and Spotify items are stored as URI + text snapshot (no artwork).
 */
import type { Queryable } from '$lib/server/db';
import type { HubConfig } from '$lib/server/env';
import { BadInput } from '$lib/shared/custom';
import type { MixItem, MixSource, Mode } from '$lib/conductor/machine';
import { median } from '$lib/conductor/machine';
import { enqueueAndDispatch } from './jobs';

const TRACK = /^spotify:track:[A-Za-z0-9]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_MIX_ITEMS = 200;
/** A relay job may wait this long (hub-jobs.yml has a 20-minute job timeout). */
export const RELAY_MAX_WAIT_MS = 18 * 60_000;

export interface Mix {
	id: string;
	name: string;
	items: MixItem[];
	updatedAt: string;
}

export async function listMixes(sql: Queryable): Promise<{ id: string; name: string; itemCount: number; updatedAt: string }[]> {
	const rows = await sql<{ id: string; name: string; n: number; updated_at: Date }[]>`
		SELECT m.id, m.name, count(i.position)::int AS n, m.updated_at FROM mixes m LEFT JOIN mix_items i ON i.mix_id = m.id
		GROUP BY m.id ORDER BY m.updated_at DESC`;
	return rows.map((r) => ({ id: r.id, name: r.name, itemCount: r.n, updatedAt: new Date(r.updated_at).toISOString() }));
}

export async function createMix(sql: Queryable, name: unknown): Promise<string> {
	const n = typeof name === 'string' ? name.trim().slice(0, 100) : '';
	if (!n) throw new BadInput('Give the mix a name');
	const [r] = await sql<{ id: string }[]>`INSERT INTO mixes (name) VALUES (${n}) RETURNING id`;
	return r!.id;
}

export async function getMix(sql: Queryable, id: string): Promise<Mix | null> {
	const [m] = await sql<{ id: string; name: string; updated_at: Date }[]>`SELECT id, name, updated_at FROM mixes WHERE id = ${id}`;
	if (!m) return null;
	const items = await sql<
		{ position: number; source: MixSource; spotify_uri: string | null; media_item_id: string | null; title: string; artist: string | null; duration_ms: number | null; source_id: string | null; embeddable: boolean | null; is_preview_only: boolean | null; unavailable: boolean | null }[]
	>`
		SELECT i.position, i.source, i.spotify_uri, i.media_item_id, i.title, i.artist, coalesce(mi.duration_ms, i.duration_ms) AS duration_ms,
		       mi.source_id, mi.embeddable, mi.is_preview_only, mi.unavailable
		FROM mix_items i LEFT JOIN media_items mi ON mi.id = i.media_item_id
		WHERE i.mix_id = ${id} ORDER BY i.position`;
	return {
		id: m.id,
		name: m.name,
		updatedAt: new Date(m.updated_at).toISOString(),
		items: items.map((r) => ({
			position: r.position,
			source: r.source,
			spotifyUri: r.spotify_uri,
			mediaItemId: r.media_item_id,
			sourceId: r.source_id,
			title: r.title,
			artist: r.artist,
			durationMs: r.duration_ms,
			skip: r.source !== 'spotify' && (r.embeddable === false || !!r.is_preview_only || !!r.unavailable)
		}))
	};
}

/** Replace a mix's items. Spotify titles come from your own history (never fetched from Spotify). */
export async function saveMixItems(sql: Queryable, id: string, raw: unknown, name?: unknown): Promise<void> {
	if (!Array.isArray(raw) || raw.length > MAX_MIX_ITEMS) throw new BadInput(`A mix holds up to ${MAX_MIX_ITEMS} items`);
	const want = raw.map((x) => x as { source?: unknown; spotifyUri?: unknown; mediaItemId?: unknown });
	const spotify = want.filter((x) => x.source === 'spotify').map((x) => String(x.spotifyUri ?? ''));
	const media = want.filter((x) => x.source !== 'spotify').map((x) => String(x.mediaItemId ?? ''));
	if (spotify.some((u) => !TRACK.test(u))) throw new BadInput('Spotify items must be track URIs');
	if (media.some((u) => !UUID.test(u))) throw new BadInput('Unknown YouTube/SoundCloud item');
	const names = spotify.length
		? await sql<{ track_uri: string; track_name: string; artist_name: string }[]>`
			SELECT track_uri, track_name, artist_name FROM hub.mv_track_stats WHERE track_uri = ANY(${spotify})`
		: [];
	const mediaRows = media.length
		? await sql<{ id: string; source: MixSource; title: string; artist_display: string | null; duration_ms: number | null }[]>`
			SELECT id, source, title, artist_display, duration_ms FROM media_items WHERE id = ANY(${media}::uuid[])`
		: [];
	const meta = await sql<{ track_uri: string; duration_ms: number | null }[]>`SELECT track_uri, duration_ms FROM track_metadata WHERE track_uri = ANY(${spotify})`;
	const rows = want.map((x, position) => {
		if (x.source === 'spotify') {
			const u = String(x.spotifyUri);
			const n = names.find((r) => r.track_uri === u);
			return { position, source: 'spotify' as const, spotify_uri: u, media_item_id: null, title: n?.track_name || u, artist: n?.artist_name ?? null, duration_ms: meta.find((r) => r.track_uri === u)?.duration_ms ?? null };
		}
		const m = mediaRows.find((r) => r.id === String(x.mediaItemId));
		if (!m) throw new BadInput('Unknown YouTube/SoundCloud item');
		return { position, source: m.source, spotify_uri: null, media_item_id: m.id, title: m.title, artist: m.artist_display, duration_ms: m.duration_ms };
	});
	const [ok] = await sql<{ id: string }[]>`UPDATE mixes SET updated_at = now(), name = coalesce(${typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null}, name) WHERE id = ${id} RETURNING id`;
	if (!ok) throw new BadInput('No such mix');
	await sql`DELETE FROM mix_items WHERE mix_id = ${id}`;
	for (const r of rows) {
		await sql`INSERT INTO mix_items (mix_id, position, source, spotify_uri, media_item_id, title, artist, duration_ms)
			VALUES (${id}, ${r.position}, ${r.source}, ${r.spotify_uri}, ${r.media_item_id}, ${r.title}, ${r.artist}, ${r.duration_ms})`;
	}
}

export async function deleteMix(sql: Queryable, id: string): Promise<boolean> {
	return (await sql`DELETE FROM mixes WHERE id = ${id}`).count > 0;
}

// ── Sessions + telemetry ─────────────────────────────────────────────────────

export async function startSession(sql: Queryable, mixId: string, mode: Mode, deviceLabel: string | null, spotifyDeviceId: string | null): Promise<string> {
	const [r] = await sql<{ id: string }[]>`
		INSERT INTO playback_sessions (mix_id, mode, device_label, spotify_device_id) VALUES (${mixId}, ${mode}, ${deviceLabel}, ${spotifyDeviceId}) RETURNING id`;
	return r!.id;
}

const OUTCOMES = new Set(['ok', 'autoplay_blocked', 'not_embeddable', 'diverged', 'spotify_autoplay', 'timeout', 'relay', 'preview_skipped']);
const SOURCES = new Set(['spotify', 'youtube', 'soundcloud', null]);

export async function logEvent(sql: Queryable, sessionId: string, b: Record<string, unknown>): Promise<void> {
	const outcome = String(b.outcome ?? '');
	if (!OUTCOMES.has(outcome)) throw new BadInput('unknown outcome');
	const from = (b.from ?? null) as string | null;
	const to = (b.to ?? null) as string | null;
	if (!SOURCES.has(from) || !SOURCES.has(to)) throw new BadInput('unknown source');
	const gap = typeof b.gapMs === 'number' && Number.isFinite(b.gapMs) ? Math.max(0, Math.min(600_000, Math.round(b.gapMs))) : null;
	const position = Number.isInteger(b.position) ? (b.position as number) : null;
	await sql`INSERT INTO handoff_events (session_id, from_source, to_source, position, outcome, gap_ms, detail)
		VALUES (${sessionId}, ${from}, ${to}, ${position}, ${outcome}, ${gap}, ${JSON.stringify(b.detail ?? {})}::text::jsonb)`;
}

export async function setProgress(sql: Queryable, sessionId: string, position: unknown): Promise<void> {
	if (!Number.isInteger(position) || (position as number) < 0) throw new BadInput('position must be a whole number');
	await sql`UPDATE playback_sessions SET position = ${position as number}, progress_at = now() WHERE id = ${sessionId} AND ended_at IS NULL`;
}

/**
 * iPhone relay mode: the page tells us when its Spotify part should end and which in-app item
 * comes next. A hub job (Python) waits for that moment and pushes "tap to continue", unless the
 * page moved on by itself (it was still open).
 */
export async function scheduleRelay(sql: Queryable, cfg: Pick<HubConfig, 'githubDispatchToken' | 'githubRepository'>, sessionId: string, b: Record<string, unknown>, f: typeof fetch = fetch) {
	const inMs = Number(b.inMs);
	if (!Number.isFinite(inMs) || inMs < 0) throw new BadInput('inMs must be the milliseconds until the Spotify part ends');
	if (!Number.isInteger(b.position)) throw new BadInput('position must be the next mix position');
	const [s] = await sql<{ mix_id: string; mode: string }[]>`SELECT mix_id, mode FROM playback_sessions WHERE id = ${sessionId} AND ended_at IS NULL`;
	if (!s) throw new BadInput('No running session');
	const notifyAt = new Date(Date.now() + Math.min(inMs, RELAY_MAX_WAIT_MS)).toISOString();
	const label = typeof b.label === 'string' ? b.label.slice(0, 80) : 'YouTube';
	return enqueueAndDispatch(
		sql,
		cfg,
		'mix_relay',
		{ session_id: sessionId, mix_id: s.mix_id, position: b.position, notify_at: notifyAt, label, capped: inMs > RELAY_MAX_WAIT_MS },
		`mix_relay:${sessionId}:${b.position}`,
		f
	);
}

export interface SessionSummary {
	id: string;
	mixId: string;
	mode: Mode;
	startedAt: string;
	endedAt: string | null;
	events: { at: string; from: string | null; to: string | null; outcome: string; gapMs: number | null; position: number | null }[];
	medianGapMs: number | null;
	handoffs: number;
	okHandoffs: number;
}

export async function endSession(sql: Queryable, sessionId: string, finalState: unknown): Promise<void> {
	await sql`UPDATE playback_sessions SET ended_at = coalesce(ended_at, now()), final_state = ${JSON.stringify(finalState ?? {})}::text::jsonb WHERE id = ${sessionId}`;
}

export async function sessionSummary(sql: Queryable, sessionId: string): Promise<SessionSummary | null> {
	const [s] = await sql<{ id: string; mix_id: string; mode: Mode; started_at: Date; ended_at: Date | null }[]>`
		SELECT id, mix_id, mode, started_at, ended_at FROM playback_sessions WHERE id = ${sessionId}`;
	if (!s) return null;
	const ev = await sql<{ at: Date; from_source: string | null; to_source: string | null; outcome: string; gap_ms: number | null; position: number | null }[]>`
		SELECT at, from_source, to_source, outcome, gap_ms, position FROM handoff_events WHERE session_id = ${sessionId} ORDER BY at, id`;
	const handoffs = ev.filter((e) => e.from_source && e.to_source && e.from_source !== e.to_source);
	const ok = handoffs.filter((e) => e.outcome === 'ok');
	return {
		id: s.id,
		mixId: s.mix_id,
		mode: s.mode,
		startedAt: new Date(s.started_at).toISOString(),
		endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null,
		events: ev.map((e) => ({ at: new Date(e.at).toISOString(), from: e.from_source, to: e.to_source, outcome: e.outcome, gapMs: e.gap_ms, position: e.position })),
		medianGapMs: median(ok.map((e) => e.gap_ms).filter((g): g is number => g !== null)),
		handoffs: handoffs.length,
		okHandoffs: ok.length
	};
}
