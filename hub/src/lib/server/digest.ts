/**
 * "This week" (R8): stored digests (digest_runs, 0029) and, for older weeks, the Top lists rebuilt
 * from playlist_rank_history. Track names come from the rollups (hub.mv_track_stats), artists from
 * track_metadata when known — the same preference as the mail's hydration.
 */
import type { Queryable } from '$lib/server/db';
import {
	arrowFor,
	isWeek,
	mondayOf,
	showArrows,
	type DigestPayload,
	type DigestPlaylist,
	type DigestRun,
	type DigestSection,
	type DigestWeekRef,
	type TrackRef
} from '$lib/shared/digest';

interface StoredPlaylist {
	section: DigestSection;
	name: string;
	kind: string;
	isTop: boolean;
	playlistId: string | null;
	description: string | null;
	added: string[];
	removed: string[];
	addedCount: number;
	ranked: { uri: string; rank: number; plays: number | null; prev: number | null }[];
	arrows: boolean;
}
interface StoredContent {
	playlists?: StoredPlaylist[];
	deleted?: { name: string; expiresAt: string | null; trackCount: number | null }[];
	counts?: DigestRun['counts'];
}

const iso = (d: Date | string) => new Date(d).toISOString();

function isMissingTable(e: unknown): boolean {
	return typeof e === 'object' && e !== null && (e as { code?: string }).code === '42P01';
}

async function names(sql: Queryable, uris: string[]): Promise<Map<string, TrackRef>> {
	const uniq = [...new Set(uris)];
	if (!uniq.length) return new Map();
	const rows = await sql<{ uri: string; name: string | null; artist: string | null }[]>`
		SELECT u.uri, ts.track_name AS name,
		       coalesce(nullif(array_to_string(tm.artist_names, ', '), ''), ts.artist_name) AS artist
		FROM unnest(${uniq}::text[]) AS u(uri)
		LEFT JOIN hub.mv_track_stats ts ON ts.track_uri = u.uri
		LEFT JOIN track_metadata tm ON tm.track_uri = u.uri`;
	return new Map(rows.map((r) => [r.uri, { uri: r.uri, name: r.name, artist: r.artist }]));
}

const ref = (m: Map<string, TrackRef>, uri: string): TrackRef => m.get(uri) ?? { uri, name: null, artist: null };

/** Weeks with a stored digest or a rank snapshot, newest first (≤ 2 years). */
async function weeks(sql: Queryable, storing: boolean): Promise<DigestWeekRef[]> {
	const stored = storing
		? await sql<{ week: string; changed: number }[]>`
				SELECT to_char(date_trunc('week', ran_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD') AS week,
				       sum(coalesce((content->'counts'->>'created')::int, 0) + coalesce((content->'counts'->>'updated')::int, 0)
				           + coalesce((content->'counts'->>'snapshots')::int, 0))::int AS changed
				FROM digest_runs WHERE run_type IN ('weekly', 'monthly') GROUP BY 1`
		: [];
	const ranks = await sql<{ week: string; changed: number }[]>`
		SELECT to_char(date_trunc('week', snapshot_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD') AS week,
		       count(DISTINCT playlist_id)::int AS changed
		FROM playlist_rank_history GROUP BY 1`;
	const map = new Map<string, DigestWeekRef>();
	for (const r of ranks) map.set(r.week, { week: r.week, stored: false, changed: r.changed });
	for (const r of stored) map.set(r.week, { week: r.week, stored: true, changed: r.changed });
	return [...map.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, 104);
}

async function storedRuns(sql: Queryable, week: string): Promise<DigestRun[]> {
	const rows = await sql<{ id: string; run_type: DigestRun['runType']; ran_at: Date; summary: string; event_count: number; delivery_status: string | null; content: StoredContent }[]>`
		SELECT id, run_type, ran_at, summary, event_count, delivery_status, content FROM digest_runs
		WHERE (ran_at AT TIME ZONE 'Europe/Amsterdam') >= ${week}::date
		  AND (ran_at AT TIME ZONE 'Europe/Amsterdam') < ${week}::date + 7
		ORDER BY ran_at DESC`;
	const uris = rows.flatMap((r) => (r.content.playlists ?? []).flatMap((p) => [...p.added, ...p.removed, ...p.ranked.map((t) => t.uri)]));
	const m = await names(sql, uris);
	return rows.map((r) => ({
		id: Number(r.id),
		runType: r.run_type,
		ranAt: iso(r.ran_at),
		summary: r.summary,
		eventCount: r.event_count,
		delivery: r.delivery_status,
		counts: r.content.counts ?? { created: 0, updated: 0, snapshots: 0, deleted: 0 },
		playlists: (r.content.playlists ?? []).map(
			(p): DigestPlaylist => ({
				section: p.section,
				name: p.name,
				kind: p.kind,
				isTop: p.isTop,
				playlistId: p.playlistId,
				description: p.description,
				addedCount: p.addedCount,
				added: p.added.map((u) => ref(m, u)),
				removed: p.removed.map((u) => ref(m, u)),
				ranked: p.ranked.map((t) => ({ ...ref(m, t.uri), rank: t.rank, prev: t.prev, plays: t.plays, arrow: arrowFor(t.rank, t.prev) })),
				arrows: p.arrows
			})
		),
		deleted: r.content.deleted ?? []
	}));
}

/** The rank-tracked Top lists' snapshot(s) taken in `week`, each against its previous snapshot. */
async function reconstruct(sql: Queryable, week: string): Promise<DigestPlaylist[]> {
	const rows = await sql<{ playlist_id: string; name: string | null; track_uri: string; rank: number; prev: number | null; has_prev: boolean }[]>`
		WITH latest AS (
			SELECT playlist_id, max(snapshot_at) AS s FROM playlist_rank_history
			WHERE (snapshot_at AT TIME ZONE 'Europe/Amsterdam') >= ${week}::date
			  AND (snapshot_at AT TIME ZONE 'Europe/Amsterdam') < ${week}::date + 7
			GROUP BY playlist_id
		), base AS (
			SELECT l.playlist_id, l.s,
			       (SELECT max(h.snapshot_at) FROM playlist_rank_history h WHERE h.playlist_id = l.playlist_id AND h.snapshot_at < l.s) AS p
			FROM latest l
		)
		SELECT b.playlist_id, sp.name, h.track_uri, h.rank, ph.rank AS prev, b.p IS NOT NULL AS has_prev
		FROM base b
		JOIN playlist_rank_history h ON h.playlist_id = b.playlist_id AND h.snapshot_at = b.s
		LEFT JOIN playlist_rank_history ph ON ph.playlist_id = b.playlist_id AND ph.snapshot_at = b.p AND ph.track_uri = h.track_uri
		LEFT JOIN spotify_playlists sp ON sp.playlist_id = b.playlist_id
		ORDER BY sp.name NULLS LAST, b.playlist_id, h.rank`;
	const m = await names(sql, rows.map((r) => r.track_uri));
	const by = new Map<string, { name: string; hasPrev: boolean; ranked: DigestPlaylist['ranked'] }>();
	for (const r of rows) {
		let p = by.get(r.playlist_id);
		if (!p) by.set(r.playlist_id, (p = { name: r.name ?? r.playlist_id, hasPrev: r.has_prev, ranked: [] }));
		const prev = r.has_prev ? r.prev : null;
		p.ranked.push({ ...ref(m, r.track_uri), rank: r.rank, prev, plays: null, arrow: arrowFor(r.rank, prev) });
	}
	return [...by.entries()].map(([id, p]) => ({
		section: 'updated',
		name: p.name,
		kind: 'updating',
		isTop: true,
		playlistId: id,
		description: null,
		addedCount: p.ranked.length,
		added: [],
		removed: [],
		ranked: p.ranked,
		arrows: showArrows(p.ranked, p.hasPrev)
	}));
}

async function lastWeekly(sql: Queryable, storing: boolean): Promise<DigestPayload['lastWeekly']> {
	if (!storing) return null;
	const [r] = await sql<{ ran_at: Date; changed: number }[]>`
		SELECT ran_at, (coalesce((content->'counts'->>'created')::int, 0) + coalesce((content->'counts'->>'updated')::int, 0)
		               + coalesce((content->'counts'->>'snapshots')::int, 0))::int AS changed
		FROM digest_runs WHERE run_type = 'weekly' ORDER BY ran_at DESC LIMIT 1`;
	return r ? { ranAt: iso(r.ran_at), changed: r.changed } : null;
}

async function hasDigestTable(sql: Queryable): Promise<boolean> {
	try {
		await sql`SELECT 1 FROM digest_runs LIMIT 1`;
		return true;
	} catch (e) {
		if (isMissingTable(e)) return false;
		throw e;
	}
}

/** `week` = a Monday (YYYY-MM-DD) or null for the newest week with data (or this week). */
export async function digestPayload(sql: Queryable, week: string | null, today: string): Promise<DigestPayload> {
	const storing = await hasDigestTable(sql);
	const [list, last] = await Promise.all([weeks(sql, storing), lastWeekly(sql, storing)]);
	const wk = isWeek(week) ? week : (list[0]?.week ?? mondayOf(today));
	const runs = storing ? await storedRuns(sql, wk) : [];
	const hasWeekly = runs.some((r) => r.runType === 'weekly' || r.runType === 'monthly');
	const rebuilt = hasWeekly ? null : await reconstruct(sql, wk);
	const i = list.findIndex((w) => w.week === wk);
	const older = i >= 0 ? list[i + 1] : list.find((w) => w.week < wk);
	const newer = i > 0 ? list[i - 1] : i < 0 ? [...list].reverse().find((w) => w.week > wk) : undefined;
	return {
		week: wk,
		weeks: list,
		prev: older?.week ?? null,
		next: newer?.week ?? null,
		runs,
		reconstructed: rebuilt && rebuilt.length ? rebuilt : null,
		storing,
		lastWeekly: last
	};
}
