/**
 * Own tracks (v0.94), server side: create/edit/delete with full validation, artist linking, duplicate
 * check, Rotor plays (own_plays, source 'rotor', never spotify_plays) and Rotor-only lists.
 *
 * Nothing here imports the Spotify client: own tracks can never reach a Spotify playlist.
 */
import type { Queryable, Sql } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';
import {
	ROLES,
	dupeKey,
	isPlaceholder,
	normTitle,
	ownKey,
	listKey,
	similar,
	validateOwnTrack,
	type ArtistLink,
	type CleanOwnTrack,
	type DuplicateMatch,
	type Errors,
	type OwnTrack,
	type Role,
	type RotorList
} from '$lib/shared/own';
export type { RotorList };
import { Conflict, deleteOrphans, isUuid, requireReady, type MediaDeps } from './media';

export class Invalid extends Error {
	constructor(readonly errors: Errors | Record<string, string>) {
		super(Object.values(errors)[0] ?? 'Invalid');
		this.name = 'Invalid';
	}
}
export class DuplicateFound extends Error {
	constructor(readonly matches: DuplicateMatch[]) {
		super(`Looks like a duplicate of “${matches[0]?.title}” by ${matches[0]?.artist}`);
		this.name = 'DuplicateFound';
	}
}

export interface OwnDeps {
	sql: Sql;
	/** null when storage isn't configured (YouTube/SoundCloud-only tracks still work). */
	media: MediaDeps | null;
}

// ── artists ──────────────────────────────────────────────────────────────────

export interface ArtistOption extends ArtistLink {
	plays: number | null;
}

/** Artists to link: yours from Spotify (by plays) and the Rotor artists you created. */
export async function artistOptions(sql: Queryable, raw: string): Promise<ArtistOption[]> {
	const q = raw.trim().slice(0, 100);
	if (!q) return [];
	const p = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const [sp, ro] = await Promise.all([
		sql<{ id: string; name: string; plays: number }[]>`
			SELECT artist_id AS id, artist_name AS name, plays FROM hub.mv_artist_stats
			WHERE artist_name ILIKE ${p} ORDER BY (lower(artist_name) = lower(${q})) DESC, plays DESC LIMIT 8`,
		sql<{ id: string; name: string }[]>`
			SELECT id::text, name FROM rotor_artists WHERE name ILIKE ${p} ORDER BY (lower(name) = lower(${q})) DESC, name LIMIT 8`
	]);
	return [...sp.map((a) => ({ kind: 'spotify' as const, id: a.id, name: a.name, plays: a.plays })), ...ro.map((a) => ({ kind: 'rotor' as const, id: a.id, name: a.name, plays: null }))];
}

/** Exact-name matches in your data (prefill turns suggested names into links with these). */
export async function artistsByName(sql: Queryable, names: string[]): Promise<Map<string, ArtistLink>> {
	const out = new Map<string, ArtistLink>();
	const list = [...new Set(names.map((n) => n.trim()).filter((n) => n && !isPlaceholder(n)))].slice(0, 20);
	if (!list.length) return out;
	const lower = list.map((n) => n.toLowerCase());
	const [sp, ro] = await Promise.all([
		sql<{ id: string; name: string }[]>`
			SELECT DISTINCT ON (lower(artist_name)) artist_id AS id, artist_name AS name FROM hub.mv_artist_stats
			WHERE lower(artist_name) = ANY(${lower}) ORDER BY lower(artist_name), plays DESC`,
		sql<{ id: string; name: string }[]>`SELECT id::text, name FROM rotor_artists WHERE lower(btrim(name)) = ANY(${lower})`
	]);
	for (const a of ro) out.set(a.name.toLowerCase(), { kind: 'rotor', id: a.id, name: a.name });
	for (const a of sp) out.set(a.name.toLowerCase(), { kind: 'spotify', id: a.id, name: a.name });
	return out;
}

/** Create an artist that isn't in your Spotify history, explicitly. */
export async function createRotorArtist(sql: Queryable, body: { name?: unknown; force?: unknown }): Promise<ArtistLink> {
	const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
	if (!name) throw new Invalid({ name: 'Artist name is required' });
	if (isPlaceholder(name)) throw new Invalid({ name: `“${name}” is a placeholder, not an artist` });
	if (name.length > 200) throw new Invalid({ name: 'At most 200 characters' });
	const known = (await artistsByName(sql, [name])).get(name.toLowerCase());
	if (known?.kind === 'rotor') return known;
	if (known?.kind === 'spotify' && body.force !== true) throw new Conflict(`${known.name} is already in your data: link that one`, { existing: known });
	const [r] = await sql<{ id: string; name: string }[]>`
		INSERT INTO rotor_artists (name) VALUES (${name})
		ON CONFLICT (lower(btrim(name))) DO UPDATE SET name = rotor_artists.name
		RETURNING id::text, name`;
	return { kind: 'rotor', id: r!.id, name: r!.name };
}

/** Every link must exist; names come from the database, not the request. */
export async function resolveLinks(sql: Queryable, links: ArtistLink[]): Promise<ArtistLink[]> {
	const sp = links.filter((l) => l.kind === 'spotify').map((l) => l.id);
	const ro = links.filter((l) => l.kind === 'rotor').map((l) => l.id);
	const [a, b] = await Promise.all([
		sp.length ? sql<{ id: string; name: string }[]>`SELECT artist_id AS id, artist_name AS name FROM hub.mv_artist_stats WHERE artist_id = ANY(${sp})` : Promise.resolve([]),
		ro.length ? sql<{ id: string; name: string }[]>`SELECT id::text, name FROM rotor_artists WHERE id = ANY(${ro}::uuid[])` : Promise.resolve([])
	]);
	const names = new Map([...a.map((x) => [`spotify:${x.id}`, x.name] as const), ...b.map((x) => [`rotor:${x.id}`, x.name] as const)]);
	return links.map((l) => {
		const n = names.get(`${l.kind}:${l.id}`);
		if (!n) throw new Invalid({ artists: `${l.name} isn’t in your data. Pick it from the list or create it as a new artist.` });
		return { ...l, name: n };
	});
}

// ── reading ──────────────────────────────────────────────────────────────────

interface TrackRow {
	id: string;
	title: string;
	version: string | null;
	status: OwnTrack['status'];
	duration_ms: number;
	label: string | null;
	date_kind: OwnTrack['dateKind'];
	date_value: string | Date | null;
	heard_set_id: string | null;
	heard_set_title: string | null;
	heard_at_ms: number | null;
	heard_note: string | null;
	notes: string | null;
	cover_url: string | null;
	cover_object_id: string | null;
	youtube_id: string | null;
	soundcloud_url: string | null;
	audio_object_id: string | null;
	audio_type: string | null;
	audio_size: string | number | null;
	audio_name: string | null;
	plays: number;
	last_played_at: Date | null;
	created_at: Date;
	credits: { role: Role; kind: 'spotify' | 'rotor'; id: string; name: string; position: number }[] | null;
}

const dateStr = (v: string | Date | null) => (v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function toTrack(r: TrackRow): OwnTrack {
	const artists = { primary: [], featuring: [], remixer: [], producer: [] } as Record<Role, ArtistLink[]>;
	for (const c of [...(r.credits ?? [])].sort((a, b) => a.position - b.position)) artists[c.role].push({ kind: c.kind, id: c.id, name: c.name });
	return {
		id: r.id,
		title: r.title,
		version: r.version,
		status: r.status,
		durationMs: r.duration_ms,
		artists,
		label: r.label,
		dateKind: r.date_kind,
		date: dateStr(r.date_value),
		heardSet: r.heard_set_id ? { id: r.heard_set_id, title: r.heard_set_title ?? 'Set' } : null,
		heardAtMs: r.heard_at_ms,
		heardNote: r.heard_note,
		notes: r.notes,
		cover: r.cover_object_id ? `/api/media/${r.cover_object_id}/art` : r.cover_url,
		coverUrl: r.cover_url,
		coverObjectId: r.cover_object_id,
		youtubeId: r.youtube_id,
		soundcloudUrl: r.soundcloud_url,
		audio: r.audio_object_id ? { id: r.audio_object_id, contentType: r.audio_type ?? 'audio/mpeg', size: Number(r.audio_size ?? 0), name: r.audio_name } : null,
		plays: r.plays,
		lastPlayedAt: r.last_played_at ? new Date(r.last_played_at).toISOString() : null,
		createdAt: new Date(r.created_at).toISOString()
	};
}

async function selectTracks(sql: Queryable, where: { id?: string; ids?: string[]; q?: string; artistId?: string; limit?: number }): Promise<OwnTrack[]> {
	const p = where.q ? `%${where.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
	const rows = await sql<TrackRow[]>`
		SELECT t.*, s.title AS heard_set_title, m.content_type AS audio_type, m.size_bytes AS audio_size, m.original_name AS audio_name,
		       coalesce(pl.plays, 0)::int AS plays, pl.last_played_at,
		       (SELECT jsonb_agg(jsonb_build_object('role', a.role, 'position', a.position, 'name', a.name,
		                 'kind', CASE WHEN a.spotify_artist_id IS NOT NULL THEN 'spotify' ELSE 'rotor' END,
		                 'id', coalesce(a.spotify_artist_id, a.rotor_artist_id::text)))
		          FROM own_track_artists a WHERE a.own_track_id = t.id) AS credits
		FROM own_tracks t
		LEFT JOIN dj_sets s ON s.id = t.heard_set_id
		LEFT JOIN media_objects m ON m.id = t.audio_object_id
		LEFT JOIN LATERAL (SELECT count(*) AS plays, max(played_at) AS last_played_at FROM own_plays op WHERE op.own_track_id = t.id) pl ON true
		WHERE true
		  ${where.id ? sql`AND t.id = ${where.id}` : sql``}
		  ${where.ids ? sql`AND t.id = ANY(${where.ids}::uuid[])` : sql``}
		  ${p ? sql`AND (t.title ILIKE ${p} OR t.version ILIKE ${p} OR t.label ILIKE ${p} OR EXISTS (SELECT 1 FROM own_track_artists a WHERE a.own_track_id = t.id AND a.name ILIKE ${p}))` : sql``}
		  ${where.artistId ? sql`AND EXISTS (SELECT 1 FROM own_track_artists a WHERE a.own_track_id = t.id AND (a.spotify_artist_id = ${where.artistId} OR a.rotor_artist_id::text = ${where.artistId}))` : sql``}
		ORDER BY t.created_at DESC
		LIMIT ${where.limit ?? 500}`;
	return rows.map(toTrack);
}

export async function getOwnTrack(sql: Queryable, id: string): Promise<OwnTrack | null> {
	if (!isUuid(id)) return null;
	return (await selectTracks(sql, { id }))[0] ?? null;
}
export const listOwnTracks = (sql: Queryable, opts: { q?: string; artistId?: string } = {}) =>
	selectTracks(sql, { q: opts.q?.trim().slice(0, 100) || undefined, artistId: opts.artistId, limit: opts.q ? 30 : 500 });

// ── duplicates ───────────────────────────────────────────────────────────────

export async function findDuplicates(sql: Queryable, t: { title: string; version: string | null; artists: string[] }, excludeId: string | null = null): Promise<DuplicateMatch[]> {
	const key = dupeKey(t.artists, t.title, t.version);
	const nt = normTitle(t.title);
	if (!nt) return [];
	const own = await sql<{ id: string; title: string; version: string | null; dupe_key: string; artists: string[] }[]>`
		SELECT t.id::text, t.title, t.version, t.dupe_key,
		       coalesce((SELECT array_agg(a.name ORDER BY a.position) FROM own_track_artists a WHERE a.own_track_id = t.id AND a.role = 'primary'), '{}') AS artists
		FROM own_tracks t WHERE split_part(t.dupe_key, '|', 2) = ${nt} ${excludeId ? sql`AND t.id <> ${excludeId}` : sql``}
		LIMIT 20`;
	const out: DuplicateMatch[] = [];
	for (const o of own) {
		const exact = o.dupe_key === key;
		if (exact || similar(t, { title: o.title, artists: o.artists })) {
			out.push({ kind: 'own', id: o.id, title: o.version ? `${o.title} (${o.version})` : o.title, artist: o.artists.join(', '), strength: exact ? 'exact' : 'similar', href: `/own/${o.id}` });
		}
	}
	// Your catalog (tracks you played): same normalised title and an overlapping artist.
	const first = nt.split(' ').sort((a, b) => b.length - a.length)[0] ?? nt;
	const esc = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const artistLike = t.artists.filter((a) => a.trim()).map((a) => esc(a.trim()));
	const cat = artistLike.length
		? await sql<{ uri: string; name: string; artist: string }[]>`
			SELECT track_uri AS uri, track_name AS name, artist_name AS artist
			FROM hub.mv_track_stats
			WHERE track_name ILIKE ${esc(first)} AND artist_name ILIKE ANY(${artistLike})
			ORDER BY plays DESC LIMIT 200`.catch(() => [])
		: [];
	for (const c of cat) {
		const theirs = c.artist.split(/\s*,\s*/);
		if (similar(t, { title: c.name, artists: theirs })) {
			out.push({ kind: 'catalog', id: c.uri, title: c.name, artist: c.artist, strength: 'similar', href: `/track/${encodeURIComponent(c.uri)}` });
		}
	}
	return out.slice(0, 10);
}

// ── writing ──────────────────────────────────────────────────────────────────

async function prepare(d: OwnDeps, body: Record<string, unknown>): Promise<CleanOwnTrack> {
	const v = validateOwnTrack(body);
	if (!v.ok) throw new Invalid(v.errors);
	const t = v.value;
	for (const role of ROLES) t.artists[role] = await resolveLinks(d.sql, t.artists[role]);
	if (t.audioObjectId) await requireReady(d.sql, t.audioObjectId, 'track');
	if (t.coverObjectId) await requireReady(d.sql, t.coverObjectId, 'cover');
	if (t.heardSetId) {
		const [s] = await d.sql`SELECT 1 FROM dj_sets WHERE id = ${t.heardSetId}`;
		if (!s) throw new Invalid({ heard: 'That set doesn’t exist (any more)' });
	}
	return t;
}

async function writeCredits(tx: Queryable, id: string, t: CleanOwnTrack): Promise<void> {
	await tx`DELETE FROM own_track_artists WHERE own_track_id = ${id}`;
	for (const role of ROLES)
		for (const [i, a] of t.artists[role].entries()) {
			await tx`
				INSERT INTO own_track_artists (own_track_id, role, position, spotify_artist_id, rotor_artist_id, name)
				VALUES (${id}, ${role}, ${i}, ${a.kind === 'spotify' ? a.id : null}, ${a.kind === 'rotor' ? a.id : null}, ${a.name})`;
		}
}

export async function createOwnTrack(d: OwnDeps, body: Record<string, unknown>): Promise<OwnTrack> {
	const t = await prepare(d, body);
	if (body.confirmDuplicate !== true) {
		const dupes = await findDuplicates(d.sql, { title: t.title, version: t.version, artists: t.artists.primary.map((a) => a.name) });
		if (dupes.length) throw new DuplicateFound(dupes);
	}
	const key = dupeKey(t.artists.primary.map((a) => a.name), t.title, t.version);
	const id = await d.sql.begin(async (tx) => {
		const [r] = (await tx`
			INSERT INTO own_tracks (title, version, status, duration_ms, label, date_kind, date_value, heard_set_id, heard_at_ms, heard_note, notes,
			                        cover_url, cover_object_id, youtube_id, soundcloud_url, audio_object_id, dupe_key)
			VALUES (${t.title}, ${t.version}, ${t.status}, ${t.durationMs}, ${t.label}, ${t.dateKind}, ${t.date}, ${t.heardSetId}, ${t.heardAtMs}, ${t.heardNote}, ${t.notes},
			        ${t.coverUrl}, ${t.coverObjectId}, ${t.youtubeId}, ${t.soundcloudUrl}, ${t.audioObjectId}, ${key})
			RETURNING id::text`) as unknown as [{ id: string }];
		await writeCredits(tx, r.id, t);
		return r.id;
	});
	return (await getOwnTrack(d.sql, id))!;
}

export async function updateOwnTrack(d: OwnDeps, id: string, body: Record<string, unknown>): Promise<OwnTrack> {
	const before = await getOwnTrack(d.sql, id);
	if (!before) throw new BadInput('Unknown track');
	const t = await prepare(d, body);
	if (body.confirmDuplicate !== true) {
		const dupes = await findDuplicates(d.sql, { title: t.title, version: t.version, artists: t.artists.primary.map((a) => a.name) }, id);
		if (dupes.some((x) => x.strength === 'exact')) throw new DuplicateFound(dupes);
	}
	const key = dupeKey(t.artists.primary.map((a) => a.name), t.title, t.version);
	await d.sql.begin(async (tx) => {
		await tx`
			UPDATE own_tracks SET title = ${t.title}, version = ${t.version}, status = ${t.status}, duration_ms = ${t.durationMs}, label = ${t.label},
			  date_kind = ${t.dateKind}, date_value = ${t.date}, heard_set_id = ${t.heardSetId}, heard_at_ms = ${t.heardAtMs}, heard_note = ${t.heardNote},
			  notes = ${t.notes}, cover_url = ${t.coverUrl}, cover_object_id = ${t.coverObjectId}, youtube_id = ${t.youtubeId},
			  soundcloud_url = ${t.soundcloudUrl}, audio_object_id = ${t.audioObjectId}, dupe_key = ${key}, updated_at = now()
			WHERE id = ${id}`;
		await writeCredits(tx, id, t);
	});
	// A replaced file or cover is no longer used: remove it from storage too.
	const dropped = [before.audio?.id !== t.audioObjectId ? (before.audio?.id ?? null) : null, before.coverObjectId !== t.coverObjectId ? before.coverObjectId : null];
	await dropFiles(d, dropped);
	return (await getOwnTrack(d.sql, id))!;
}

async function dropFiles(d: OwnDeps, ids: (string | null)[]): Promise<void> {
	const list = ids.filter((x): x is string => !!x);
	if (!list.length) return;
	if (d.media) await deleteOrphans(d.media, list);
	// Storage not configured here: mark them; Settings › Storage › Clean up finishes it.
	else await d.sql`UPDATE media_objects SET status = 'deleting' WHERE id = ANY(${list}::uuid[]) AND status = 'ready'`;
}

/** Delete a track and its uploaded files (storage + database). Tracklist links become "ID" entries. */
export async function deleteOwnTrack(d: OwnDeps, id: string): Promise<{ deleted: string; files: number }> {
	const t = await getOwnTrack(d.sql, id);
	if (!t) throw new BadInput('Unknown track');
	await d.sql.begin(async (tx) => {
		await tx`
			UPDATE dj_set_tracks SET kind = 'id', own_track_id = NULL,
			  display_artist = coalesce(display_artist, ${t.artists.primary.map((a) => a.name).join(', ')}), display_title = ${t.version ? `${t.title} (${t.version})` : t.title}
			WHERE own_track_id = ${id}`;
		await tx`DELETE FROM library_items WHERE item_key = ${ownKey(id)}`;
		await tx`DELETE FROM own_tracks WHERE id = ${id}`;
	});
	const files = [t.audio?.id ?? null, t.coverObjectId];
	await dropFiles(d, files);
	return { deleted: id, files: files.filter(Boolean).length };
}

// ── plays (separate from Spotify) ────────────────────────────────────────────

export async function recordPlay(sql: Queryable, id: string, body: { msPlayed?: unknown }): Promise<{ recorded: boolean }> {
	if (!isUuid(id)) throw new BadInput('Unknown track');
	const ms = Math.round(Number(body.msPlayed));
	if (!Number.isFinite(ms) || ms < 0) throw new BadInput('msPlayed must be a number of milliseconds');
	const [t] = await sql<{ duration_ms: number }[]>`SELECT duration_ms FROM own_tracks WHERE id = ${id}`;
	if (!t) throw new BadInput('Unknown track');
	await sql`INSERT INTO own_plays (own_track_id, ms_played, source) VALUES (${id}, ${Math.min(ms, t.duration_ms + 60_000)}, 'rotor')`;
	return { recorded: true };
}

export interface OwnStats {
	plays: number;
	tracks: number;
	msPlayed: number;
	last30: number;
	top: { id: string; title: string; artist: string; plays: number }[];
	note: string;
}
export async function ownStats(sql: Queryable): Promise<OwnStats> {
	const [[s], top] = await Promise.all([
		sql<{ plays: number; tracks: number; ms: string | null; last30: number }[]>`
			SELECT count(*)::int AS plays, count(DISTINCT own_track_id)::int AS tracks, sum(ms_played) AS ms,
			       count(*) FILTER (WHERE played_at >= now() - interval '30 days')::int AS last30
			FROM own_plays WHERE source = 'rotor'`,
		sql<{ id: string; title: string; version: string | null; artist: string | null; plays: number }[]>`
			SELECT t.id::text, t.title, t.version, count(*)::int AS plays,
			       (SELECT string_agg(a.name, ', ' ORDER BY a.position) FROM own_track_artists a WHERE a.own_track_id = t.id AND a.role = 'primary') AS artist
			FROM own_plays p JOIN own_tracks t ON t.id = p.own_track_id WHERE p.source = 'rotor'
			GROUP BY t.id ORDER BY plays DESC, t.title LIMIT 10`
	]);
	return {
		plays: s?.plays ?? 0,
		tracks: s?.tracks ?? 0,
		msPlayed: Number(s?.ms ?? 0),
		last30: s?.last30 ?? 0,
		top: top.map((r) => ({ id: r.id, title: r.version ? `${r.title} (${r.version})` : r.title, artist: r.artist ?? '', plays: r.plays })),
		note: 'Plays of your own tracks in Rotor’s player. Counted apart from Spotify: never in your Spotify stats, rollups or Wrapped.'
	};
}

// ── Rotor-only lists ─────────────────────────────────────────────────────────

export async function listLists(sql: Queryable): Promise<RotorList[]> {
	const rows = await sql<{ id: string; name: string; count: number; duration: string | null; updated_at: Date }[]>`
		SELECT l.id::text, l.name, count(i.own_track_id)::int AS count, sum(t.duration_ms) AS duration, l.updated_at
		FROM rotor_lists l LEFT JOIN rotor_list_items i ON i.list_id = l.id LEFT JOIN own_tracks t ON t.id = i.own_track_id
		GROUP BY l.id ORDER BY lower(l.name)`;
	return rows.map((r) => ({ id: r.id, name: r.name, count: r.count, durationMs: Number(r.duration ?? 0), updatedAt: new Date(r.updated_at).toISOString() }));
}
function listName(v: unknown): string {
	const n = typeof v === 'string' ? v.trim() : '';
	if (!n) throw new Invalid({ name: 'A list needs a name' });
	if (isPlaceholder(n)) throw new Invalid({ name: `“${n}” is a placeholder, not a name` });
	if (n.length > 100) throw new Invalid({ name: 'At most 100 characters' });
	return n;
}
export async function createList(sql: Queryable, body: { name?: unknown }): Promise<RotorList> {
	const [r] = await sql<{ id: string }[]>`INSERT INTO rotor_lists (name) VALUES (${listName(body.name)}) RETURNING id::text`;
	return (await listLists(sql)).find((l) => l.id === r!.id)!;
}
export async function getList(sql: Queryable, id: string): Promise<(RotorList & { tracks: OwnTrack[] }) | null> {
	if (!isUuid(id)) return null;
	const l = (await listLists(sql)).find((x) => x.id === id);
	if (!l) return null;
	const order = await sql<{ own_track_id: string }[]>`SELECT own_track_id::text FROM rotor_list_items WHERE list_id = ${id} ORDER BY position`;
	const ids = order.map((o) => o.own_track_id);
	const tracks = ids.length ? await selectTracks(sql, { ids }) : [];
	const byId = new Map(tracks.map((t) => [t.id, t]));
	return { ...l, tracks: ids.map((i) => byId.get(i)).filter((t): t is OwnTrack => !!t) };
}
export async function updateList(sql: Sql, id: string, body: { name?: unknown; add?: unknown; remove?: unknown; order?: unknown }): Promise<RotorList> {
	if (!isUuid(id)) throw new BadInput('Unknown list');
	const [l] = await sql`SELECT 1 FROM rotor_lists WHERE id = ${id}`;
	if (!l) throw new BadInput('Unknown list');
	const ids = (v: unknown) => {
		if (!Array.isArray(v) || v.length > 500 || !v.every(isUuid)) throw new BadInput('Own track ids expected');
		return v as string[];
	};
	await sql.begin(async (tx) => {
		if (body.name !== undefined) await tx`UPDATE rotor_lists SET name = ${listName(body.name)} WHERE id = ${id}`;
		if (body.remove !== undefined) await tx`DELETE FROM rotor_list_items WHERE list_id = ${id} AND own_track_id = ANY(${ids(body.remove)}::uuid[])`;
		if (body.add !== undefined) {
			const add = ids(body.add);
			const found = await tx<{ id: string }[]>`SELECT id::text FROM own_tracks WHERE id = ANY(${add}::uuid[])`;
			if (found.length !== new Set(add).size) throw new BadInput('Only your own tracks go in a Rotor list (Spotify tracks stay in Spotify playlists)');
			const [{ base }] = (await tx`SELECT coalesce(max(position) + 1, 0) AS base FROM rotor_list_items WHERE list_id = ${id}`) as unknown as [{ base: number }];
			let i = 0;
			for (const t of add) {
				const r = await tx`INSERT INTO rotor_list_items (list_id, position, own_track_id) VALUES (${id}, ${base + i}, ${t}) ON CONFLICT (list_id, own_track_id) DO NOTHING`;
				if (r.count) i++;
			}
		}
		if (body.order !== undefined) {
			const order = ids(body.order);
			await tx`UPDATE rotor_list_items SET position = position + 100000 WHERE list_id = ${id}`;
			for (const [i, t] of order.entries()) await tx`UPDATE rotor_list_items SET position = ${i} WHERE list_id = ${id} AND own_track_id = ${t}`;
		}
		await tx`UPDATE rotor_lists SET updated_at = now() WHERE id = ${id}`;
	});
	return (await listLists(sql)).find((x) => x.id === id)!;
}
export async function deleteList(sql: Sql, id: string): Promise<{ deleted: string }> {
	if (!isUuid(id)) throw new BadInput('Unknown list');
	await sql.begin(async (tx) => {
		await tx`DELETE FROM library_items WHERE item_key = ${listKey(id)}`;
		const r = await tx`DELETE FROM rotor_lists WHERE id = ${id}`;
		if (!r.count) throw new BadInput('Unknown list');
	});
	return { deleted: id };
}
