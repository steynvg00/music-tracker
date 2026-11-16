/**
 * DJ / live sets (v0.94), server side: CRUD, linked DJs, tracklists and matching pasted tracklist lines
 * to your catalog (tracks you played) and your own tracks. No Spotify client in here either.
 */
import type { Queryable } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';
import { normTitle, similar, setKey, type ArtistLink } from '$lib/shared/own';
import { validateSet, type CleanSet, type DjSet, type DjSetSummary, type EntryKind, type ParsedLine, type TracklistEntry } from '$lib/shared/sets';
import { isUuid, requireReady } from './media';
import { Invalid, resolveLinks, type OwnDeps } from './own';
import { deleteOrphans } from './media';

interface SetRow {
	id: string;
	title: string;
	event: string | null;
	performed_on: string | Date | null;
	duration_ms: number;
	cover_url: string | null;
	cover_object_id: string | null;
	source: DjSet['source'];
	youtube_id: string | null;
	soundcloud_url: string | null;
	audio_object_id: string | null;
	audio_type: string | null;
	audio_size: string | number | null;
	audio_name: string | null;
	created_at: Date;
	entries: number;
	artists: { kind: 'spotify' | 'rotor'; id: string; name: string; position: number }[] | null;
}

function toSummary(r: SetRow): DjSetSummary {
	return {
		id: r.id,
		title: r.title,
		event: r.event,
		date: r.performed_on === null ? null : r.performed_on instanceof Date ? r.performed_on.toISOString().slice(0, 10) : String(r.performed_on).slice(0, 10),
		durationMs: r.duration_ms,
		cover: r.cover_object_id ? `/api/media/${r.cover_object_id}/art` : r.cover_url,
		coverUrl: r.cover_url,
		coverObjectId: r.cover_object_id,
		source: r.source,
		youtubeId: r.youtube_id,
		soundcloudUrl: r.soundcloud_url,
		audio: r.audio_object_id ? { id: r.audio_object_id, contentType: r.audio_type ?? 'audio/mpeg', size: Number(r.audio_size ?? 0), name: r.audio_name } : null,
		artists: [...(r.artists ?? [])].sort((a, b) => a.position - b.position).map(({ kind, id, name }) => ({ kind, id, name })),
		createdAt: new Date(r.created_at).toISOString(),
		entries: r.entries
	};
}

async function selectSets(sql: Queryable, where: { id?: string; q?: string; artistId?: string }): Promise<DjSetSummary[]> {
	const p = where.q ? `%${where.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
	const rows = await sql<SetRow[]>`
		SELECT s.*, m.content_type AS audio_type, m.size_bytes AS audio_size, m.original_name AS audio_name,
		       (SELECT count(*)::int FROM dj_set_tracks t WHERE t.set_id = s.id) AS entries,
		       (SELECT jsonb_agg(jsonb_build_object('position', a.position, 'name', a.name,
		                 'kind', CASE WHEN a.spotify_artist_id IS NOT NULL THEN 'spotify' ELSE 'rotor' END,
		                 'id', coalesce(a.spotify_artist_id, a.rotor_artist_id::text)))
		          FROM dj_set_artists a WHERE a.set_id = s.id) AS artists
		FROM dj_sets s LEFT JOIN media_objects m ON m.id = s.audio_object_id
		WHERE true
		  ${where.id ? sql`AND s.id = ${where.id}` : sql``}
		  ${p ? sql`AND (s.title ILIKE ${p} OR s.event ILIKE ${p} OR EXISTS (SELECT 1 FROM dj_set_artists a WHERE a.set_id = s.id AND a.name ILIKE ${p}))` : sql``}
		  ${where.artistId ? sql`AND EXISTS (SELECT 1 FROM dj_set_artists a WHERE a.set_id = s.id AND (a.spotify_artist_id = ${where.artistId} OR a.rotor_artist_id::text = ${where.artistId}))` : sql``}
		ORDER BY s.performed_on DESC NULLS LAST, s.created_at DESC
		LIMIT ${where.q ? 20 : 500}`;
	return rows.map(toSummary);
}

export const listSets = (sql: Queryable, opts: { q?: string; artistId?: string } = {}) => selectSets(sql, { q: opts.q?.trim().slice(0, 100) || undefined, artistId: opts.artistId });

export async function getSet(sql: Queryable, id: string): Promise<DjSet | null> {
	if (!isUuid(id)) return null;
	const [s] = await selectSets(sql, { id });
	if (!s) return null;
	const rows = await sql<{ start_ms: number | null; kind: EntryKind; track_uri: string | null; own_track_id: string | null; display_artist: string | null; display_title: string }[]>`
		SELECT start_ms, kind, track_uri, own_track_id::text, display_artist, display_title FROM dj_set_tracks WHERE set_id = ${id} ORDER BY position`;
	const { entries: _n, ...rest } = s;
	return {
		...rest,
		tracklist: rows.map((r) => ({ startMs: r.start_ms, kind: r.kind, trackUri: r.track_uri, ownTrackId: r.own_track_id, artist: r.display_artist, title: r.display_title }))
	};
}

async function prepare(d: OwnDeps, body: Record<string, unknown>): Promise<CleanSet> {
	const v = validateSet(body);
	if (!v.ok) throw new Invalid(v.errors);
	const s = v.value;
	s.artists = await resolveLinks(d.sql, s.artists).catch((e) => {
		throw e instanceof Invalid ? new Invalid({ artists: e.message }) : e;
	});
	if (s.audioObjectId) await requireReady(d.sql, s.audioObjectId, 'set');
	if (s.coverObjectId) await requireReady(d.sql, s.coverObjectId, 'cover');
	const own = s.tracklist.filter((t) => t.kind === 'own').map((t) => t.ownTrackId!);
	if (own.length) {
		const found = await d.sql<{ id: string }[]>`SELECT id::text FROM own_tracks WHERE id = ANY(${own}::uuid[])`;
		if (found.length !== new Set(own).size) throw new Invalid({ tracklist: 'A linked own track doesn’t exist (any more)' });
	}
	return s;
}

async function writeChildren(tx: Queryable, id: string, s: CleanSet): Promise<void> {
	await tx`DELETE FROM dj_set_artists WHERE set_id = ${id}`;
	await tx`DELETE FROM dj_set_tracks WHERE set_id = ${id}`;
	for (const [i, a] of s.artists.entries())
		await tx`INSERT INTO dj_set_artists (set_id, position, spotify_artist_id, rotor_artist_id, name)
		         VALUES (${id}, ${i}, ${a.kind === 'spotify' ? a.id : null}, ${a.kind === 'rotor' ? a.id : null}, ${a.name})`;
	for (const [i, t] of s.tracklist.entries())
		await tx`INSERT INTO dj_set_tracks (set_id, position, start_ms, kind, track_uri, own_track_id, display_artist, display_title)
		         VALUES (${id}, ${i}, ${t.startMs}, ${t.kind}, ${t.trackUri}, ${t.ownTrackId}, ${t.artist}, ${t.title})`;
}

export async function createSet(d: OwnDeps, body: Record<string, unknown>): Promise<DjSet> {
	const s = await prepare(d, body);
	const id = await d.sql.begin(async (tx) => {
		const [r] = (await tx`
			INSERT INTO dj_sets (title, event, performed_on, duration_ms, cover_url, cover_object_id, source, youtube_id, soundcloud_url, audio_object_id)
			VALUES (${s.title}, ${s.event}, ${s.date}, ${s.durationMs}, ${s.coverUrl}, ${s.coverObjectId}, ${s.source}, ${s.youtubeId}, ${s.soundcloudUrl}, ${s.audioObjectId})
			RETURNING id::text`) as unknown as [{ id: string }];
		await writeChildren(tx, r.id, s);
		return r.id;
	});
	return (await getSet(d.sql, id))!;
}

export async function updateSet(d: OwnDeps, id: string, body: Record<string, unknown>): Promise<DjSet> {
	const before = await getSet(d.sql, id);
	if (!before) throw new BadInput('Unknown set');
	const s = await prepare(d, body);
	await d.sql.begin(async (tx) => {
		await tx`
			UPDATE dj_sets SET title = ${s.title}, event = ${s.event}, performed_on = ${s.date}, duration_ms = ${s.durationMs}, cover_url = ${s.coverUrl},
			  cover_object_id = ${s.coverObjectId}, source = ${s.source}, youtube_id = ${s.youtubeId}, soundcloud_url = ${s.soundcloudUrl},
			  audio_object_id = ${s.audioObjectId}, updated_at = now()
			WHERE id = ${id}`;
		await writeChildren(tx, id, s);
	});
	const dropped = [before.audio && before.audio.id !== s.audioObjectId ? before.audio.id : null, before.coverObjectId !== s.coverObjectId ? before.coverObjectId : null].filter((x): x is string => !!x);
	if (dropped.length) {
		if (d.media) await deleteOrphans(d.media, dropped);
		else await d.sql`UPDATE media_objects SET status = 'deleting' WHERE id = ANY(${dropped}::uuid[]) AND status = 'ready'`;
	}
	return (await getSet(d.sql, id))!;
}

/** Delete a set and its uploaded audio/cover (storage + database). Own tracks heard there keep their note. */
export async function deleteSet(d: OwnDeps, id: string): Promise<{ deleted: string; files: number }> {
	const s = await getSet(d.sql, id);
	if (!s) throw new BadInput('Unknown set');
	await d.sql.begin(async (tx) => {
		await tx`UPDATE own_tracks SET heard_note = coalesce(heard_note, ${`Heard in ${s.title}`}) WHERE heard_set_id = ${id}`;
		await tx`DELETE FROM library_items WHERE item_key = ${setKey(id)}`;
		await tx`DELETE FROM dj_sets WHERE id = ${id}`;
	});
	const files = [s.audio?.id ?? null, s.coverObjectId].filter((x): x is string => !!x);
	if (files.length) {
		if (d.media) await deleteOrphans(d.media, files);
		else await d.sql`UPDATE media_objects SET status = 'deleting' WHERE id = ANY(${files}::uuid[]) AND status = 'ready'`;
	}
	return { deleted: id, files: files.length };
}

// ── tracklist matching ───────────────────────────────────────────────────────

export interface LineMatch {
	line: number;
	suggestion: (Pick<TracklistEntry, 'kind' | 'trackUri' | 'ownTrackId' | 'artist' | 'title'> & { label: string }) | null;
}

/** Suggest a link for each parsed line: your own tracks first, then tracks you played. You confirm. */
export async function matchLines(sql: Queryable, lines: ParsedLine[]): Promise<LineMatch[]> {
	const usable = lines.filter((l) => !l.isId && l.artist).slice(0, 300);
	if (!usable.length) return lines.map((l) => ({ line: l.line, suggestion: null }));
	const titles = [...new Set(usable.map((l) => normTitle(l.title)).filter(Boolean))];
	const own = await sql<{ id: string; title: string; version: string | null; artists: string[] }[]>`
		SELECT t.id::text, t.title, t.version,
		       coalesce((SELECT array_agg(a.name ORDER BY a.position) FROM own_track_artists a WHERE a.own_track_id = t.id AND a.role = 'primary'), '{}') AS artists
		FROM own_tracks t WHERE split_part(t.dupe_key, '|', 2) = ANY(${titles})`;
	const words = [...new Set(usable.map((l) => (normTitle(l.title).split(' ').sort((a, b) => b.length - a.length)[0] ?? '')).filter((w) => w.length >= 3))].slice(0, 300);
	const cat = words.length
		? await sql<{ uri: string; name: string; artist: string; plays: number }[]>`
			SELECT ts.track_uri AS uri, ts.track_name AS name, ts.artist_name AS artist, ts.plays
			FROM hub.mv_track_stats ts
			WHERE ts.track_name ILIKE ANY(${words.map((w) => `%${w}%`)}) AND ts.track_uri LIKE 'spotify:track:%'
			ORDER BY ts.plays DESC LIMIT 3000`.catch(() => [])
		: [];
	return lines.map((l) => {
		if (l.isId || !l.artist) return { line: l.line, suggestion: null };
		const me = { title: l.title, artists: l.artist.split(/\s*(?:,|&| x | vs\.? | and )\s*/i) };
		const o = own.find((x) => similar(me, { title: x.title, artists: x.artists }));
		if (o) return { line: l.line, suggestion: { kind: 'own', trackUri: null, ownTrackId: o.id, artist: o.artists.join(', '), title: o.version ? `${o.title} (${o.version})` : o.title, label: 'Your own track' } };
		const c = cat.find((x) => similar(me, { title: x.name, artists: x.artist.split(/\s*,\s*/) }));
		if (c) return { line: l.line, suggestion: { kind: 'catalog', trackUri: c.uri, ownTrackId: null, artist: c.artist, title: c.name, label: `In your history · ${c.plays} plays` } };
		return { line: l.line, suggestion: null };
	});
}

export type { ArtistLink };
