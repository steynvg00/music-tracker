/**
 * Uploaded files (v0.94), server side: signing, resume, completion, playback URLs, usage and the guarded
 * delete. Only metadata touches the database (migration 0036 `media_objects`); the bytes go from the
 * browser straight to storage with short-lived signed URLs and never pass through Vercel.
 *
 * Resume: the browser reports each finished part (number + ETag) and the server keeps that list, so an
 * interrupted upload continues from any device or after a reload. When storage hides the ETag header from
 * the browser (CORS), the server falls back to ListParts. Unfinished uploads older than 24 h are aborted by
 * cleanupStale() (Supabase aborts multipart uploads after 24 h itself).
 */
import type { Queryable, Sql } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';
import { checkFile, maxBytes, partCount, uploadMode, usage, type PlaybackUrl, type Purpose, type StorageLimits, type UploadStatus, type UploadTicket, type Usage } from '$lib/shared/media';
import type { MediaStorage } from './storage/s3';

export class Conflict extends Error {
	constructor(
		message: string,
		readonly detail: Record<string, unknown> = {}
	) {
		super(message);
		this.name = 'Conflict';
	}
}
export class QuotaExceeded extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QuotaExceeded';
	}
}

export interface MediaDeps {
	sql: Sql;
	store: MediaStorage;
	limits: StorageLimits;
	uploadTtlS: number;
	playbackTtlS: number;
	now?: () => Date;
}

interface Row {
	id: string;
	object_key: string;
	purpose: Purpose;
	content_type: string;
	size_bytes: string | number;
	original_name: string | null;
	status: UploadStatus['status'];
	upload_id: string | null;
	part_size: number | null;
	parts: { n: number; etag: string }[];
	created_at: Date;
}

const DIR: Record<Purpose, string> = { track: 'tracks', set: 'sets', cover: 'covers' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

async function row(sql: Queryable, id: string): Promise<Row> {
	if (!isUuid(id)) throw new BadInput('Unknown file');
	const [r] = await sql<Row[]>`SELECT * FROM media_objects WHERE id = ${id}`;
	if (!r) throw new BadInput('Unknown file');
	return r;
}

function statusOf(r: Row, done: number[]): UploadStatus {
	const size = Number(r.size_bytes);
	const partSize = r.part_size ?? size;
	return {
		id: r.id,
		status: r.status,
		mode: r.upload_id ? 'multipart' : 'single',
		size,
		partSize,
		partCount: r.upload_id ? partCount(size, partSize) : 1,
		done,
		purpose: r.purpose,
		name: r.original_name
	};
}

export async function storageUsage(sql: Queryable, limits: StorageLimits): Promise<Usage> {
	const [r] = await sql<{ used: string | null; track: number; set: number; cover: number; pending: number }[]>`
		SELECT sum(size_bytes) FILTER (WHERE status <> 'failed') AS used,
		       count(*) FILTER (WHERE purpose = 'track' AND status = 'ready')::int AS track,
		       count(*) FILTER (WHERE purpose = 'set' AND status = 'ready')::int AS set,
		       count(*) FILTER (WHERE purpose = 'cover' AND status = 'ready')::int AS cover,
		       count(*) FILTER (WHERE status IN ('uploading', 'deleting'))::int AS pending
		FROM media_objects`;
	return usage(Number(r?.used ?? 0), limits.quotaBytes, { track: r?.track ?? 0, set: r?.set ?? 0, cover: r?.cover ?? 0 }, r?.pending ?? 0);
}

/** Accept a file (type, size, quota), create its row and sign the first step. */
export async function startUpload(d: MediaDeps, body: { purpose?: unknown; name?: unknown; size?: unknown; type?: unknown }): Promise<UploadTicket> {
	const purpose = body.purpose;
	if (purpose !== 'track' && purpose !== 'set' && purpose !== 'cover') throw new BadInput('Upload what? (track, set or cover)');
	const name = typeof body.name === 'string' ? body.name.slice(0, 200) : '';
	const size = Number(body.size);
	const check = checkFile(purpose, { name, size, type: typeof body.type === 'string' ? body.type : '' }, d.limits);
	if (!check.ok) throw new BadInput(check.error);
	const used = await storageUsage(d.sql, d.limits);
	if (used.usedBytes + size > d.limits.quotaBytes) {
		throw new QuotaExceeded(`Not enough room: ${Math.round(used.usedBytes / 1048576)} of ${Math.round(d.limits.quotaBytes / 1048576)} MB used. Delete files in Settings › Storage first.`);
	}
	const mode = uploadMode(size, d.limits.partBytes);
	const [{ id }] = (await d.sql`SELECT gen_random_uuid()::text AS id`) as unknown as [{ id: string }];
	const key = `${DIR[purpose]}/${id}.${check.ext}`;
	const uploadId = mode === 'multipart' ? await d.store.createMultipart(key, check.contentType) : null;
	await d.sql`
		INSERT INTO media_objects (id, object_key, purpose, content_type, size_bytes, original_name, upload_id, part_size)
		VALUES (${id}, ${key}, ${purpose}, ${check.contentType}, ${size}, ${name || null}, ${uploadId}, ${mode === 'multipart' ? d.limits.partBytes : null})`;
	const expiresAt = new Date((d.now?.() ?? new Date()).getTime() + d.uploadTtlS * 1000).toISOString();
	return {
		id,
		mode,
		size,
		partSize: mode === 'multipart' ? d.limits.partBytes : size,
		partCount: mode === 'multipart' ? partCount(size, d.limits.partBytes) : 1,
		url: mode === 'single' ? d.store.presignPut(key, d.uploadTtlS) : null,
		expiresAt
	};
}

function uploading(r: Row): void {
	if (r.status !== 'uploading') throw new Conflict(r.status === 'ready' ? 'That upload is already finished' : 'That upload was cancelled');
}

/** Fresh signed URLs: the parts of a multipart upload, or the single PUT again (resume after expiry). */
export async function signParts(d: MediaDeps, id: string, nums: unknown): Promise<{ urls: Record<number, string>; expiresAt: string }> {
	const r = await row(d.sql, id);
	uploading(r);
	const expiresAt = new Date((d.now?.() ?? new Date()).getTime() + d.uploadTtlS * 1000).toISOString();
	if (!r.upload_id) return { urls: { 1: d.store.presignPut(r.object_key, d.uploadTtlS) }, expiresAt };
	const total = partCount(Number(r.size_bytes), r.part_size!);
	if (!Array.isArray(nums) || !nums.length || nums.length > 100) throw new BadInput('Which parts?');
	const urls: Record<number, string> = {};
	for (const v of nums) {
		const n = Number(v);
		if (!Number.isInteger(n) || n < 1 || n > total) throw new BadInput(`No part ${String(v).slice(0, 10)}`);
		urls[n] = d.store.presignPart(r.object_key, r.upload_id, n, d.uploadTtlS);
	}
	return { urls, expiresAt };
}

/** The browser finished a part: remember its ETag (for resume and completion). */
export async function reportPart(d: MediaDeps, id: string, body: { n?: unknown; etag?: unknown }): Promise<{ done: number[] }> {
	const r = await row(d.sql, id);
	uploading(r);
	if (!r.upload_id) throw new BadInput('Not a multipart upload');
	const n = Number(body.n);
	const total = partCount(Number(r.size_bytes), r.part_size!);
	if (!Number.isInteger(n) || n < 1 || n > total) throw new BadInput('No such part');
	const etag = typeof body.etag === 'string' && body.etag.length <= 200 ? body.etag : '';
	const [u] = await d.sql<{ parts: { n: number; etag: string }[] }[]>`
		UPDATE media_objects
		SET parts = (SELECT coalesce(jsonb_agg(p ORDER BY (p->>'n')::int), '[]'::jsonb)
		             FROM (SELECT p FROM jsonb_array_elements(parts) p WHERE (p->>'n')::int <> ${n}
		                   UNION ALL SELECT jsonb_build_object('n', ${n}::int, 'etag', ${etag}::text)) x)
		WHERE id = ${id} AND status = 'uploading'
		RETURNING parts`;
	return { done: (u?.parts ?? []).map((p) => p.n) };
}

/** Where an upload stands: which parts storage already has (resume). */
export async function uploadStatus(d: MediaDeps, id: string): Promise<UploadStatus> {
	const r = await row(d.sql, id);
	if (r.status !== 'uploading' || !r.upload_id) return statusOf(r, r.status === 'ready' ? [1] : []);
	const recorded = new Map(r.parts.filter((p) => p.etag).map((p) => [p.n, p.etag]));
	try {
		// Storage's own list wins (also covers parts reported without a readable ETag).
		for (const p of await d.store.listParts(r.object_key, r.upload_id)) recorded.set(p.n, p.etag);
	} catch {
		/* ListParts unsupported/unreachable: the recorded ETags are the truth */
	}
	return statusOf(r, [...recorded.keys()].sort((a, b) => a - b));
}

/** Finish: every part present → complete → HEAD must show the announced size → ready. */
export async function completeUpload(d: MediaDeps, id: string): Promise<UploadStatus> {
	const r = await row(d.sql, id);
	if (r.status === 'ready') return statusOf(r, [1]);
	uploading(r);
	const size = Number(r.size_bytes);
	if (r.upload_id) {
		const total = partCount(size, r.part_size!);
		let parts = r.parts.filter((p) => p.etag);
		if (parts.length < total) {
			// The browser couldn't read ETags (CORS): ask storage.
			const listed = await d.store.listParts(r.object_key, r.upload_id).catch(() => []);
			const byN = new Map(parts.map((p) => [p.n, p.etag]));
			for (const p of listed) byN.set(p.n, p.etag);
			parts = [...byN].map(([n, etag]) => ({ n, etag }));
		}
		const have = new Set(parts.map((p) => p.n));
		const missing = [...Array(total).keys()].map((i) => i + 1).filter((n) => !have.has(n));
		if (missing.length) throw new Conflict(`Upload incomplete: part${missing.length === 1 ? '' : 's'} ${missing.slice(0, 5).join(', ')} still missing`, { missing });
		await d.store.completeMultipart(r.object_key, r.upload_id, parts.filter((p) => p.n <= total));
	}
	const head = await d.store.head(r.object_key);
	if (!head) throw new Conflict('The file isn’t in storage yet. Retry the upload.');
	if (head.size !== size) {
		throw new Conflict(`Storage has ${head.size} bytes, expected ${size}. Retry the upload.`);
	}
	await d.sql`UPDATE media_objects SET status = 'ready', completed_at = now(), parts = '[]'::jsonb WHERE id = ${id} AND status = 'uploading'`;
	return statusOf({ ...r, status: 'ready' }, [1]);
}

/** Cancel an upload: abort it in storage (or remove the partial object) and forget it. */
export async function cancelUpload(d: MediaDeps, id: string): Promise<{ cancelled: string }> {
	const r = await row(d.sql, id);
	if (r.status === 'ready') throw new Conflict('That file is finished; delete it instead');
	if (r.upload_id) await d.store.abortMultipart(r.object_key, r.upload_id);
	else await d.store.delete(r.object_key);
	await d.sql`DELETE FROM media_objects WHERE id = ${id} AND status <> 'ready'`;
	return { cancelled: id };
}

/** A short-lived signed GET for Rotor's own player. */
export async function playbackUrl(d: MediaDeps, id: string): Promise<PlaybackUrl> {
	const r = await row(d.sql, id);
	if (r.status !== 'ready') throw new Conflict('That file isn’t ready to play');
	return {
		url: d.store.presignGet(r.object_key, d.playbackTtlS),
		expiresAt: new Date((d.now?.() ?? new Date()).getTime() + d.playbackTtlS * 1000).toISOString(),
		contentType: r.content_type
	};
}

/** Must the file stay? (it's the only source of a track or a set's audio) */
async function blockers(sql: Queryable, id: string): Promise<string[]> {
	const rows = await sql<{ what: string }[]>`
		SELECT 'the own track “' || title || '”' AS what FROM own_tracks
		WHERE audio_object_id = ${id} AND youtube_id IS NULL AND soundcloud_url IS NULL
		UNION ALL
		SELECT 'the set “' || title || '”' FROM dj_sets WHERE audio_object_id = ${id}`;
	return rows.map((r) => r.what);
}

/**
 * Delete a file: storage AND database, guarded.
 *   1. refuse when it is the only source of a track or a set (delete the track/set, or add a source first)
 *   2. mark it 'deleting' (it stops counting as playable at once)
 *   3. delete the object in storage (idempotent)
 *   4. in one transaction: unlink it from tracks/covers and delete the row
 * If 3 fails the row goes back to 'ready' (nothing lost); if 4 fails the row stays 'deleting' and the next
 * cleanupStale() finishes it. Either way the database never points at a file storage doesn't have.
 */
export async function deleteMedia(d: MediaDeps, id: string): Promise<{ deleted: string }> {
	const r = await row(d.sql, id);
	const b = await blockers(d.sql, id);
	if (b.length) throw new Conflict(`This file is the only source of ${b.join(' and ')}. Add another source or delete that first.`, { blockers: b });
	if (r.status === 'uploading') return cancelUpload(d, id).then(() => ({ deleted: id }));
	await d.sql`UPDATE media_objects SET status = 'deleting' WHERE id = ${id}`;
	try {
		await d.store.delete(r.object_key);
	} catch (e) {
		await d.sql`UPDATE media_objects SET status = 'ready' WHERE id = ${id} AND status = 'deleting'`;
		throw e;
	}
	await forgetDeleted(d.sql, id);
	return { deleted: id };
}

async function forgetDeleted(sql: Sql, id: string): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`UPDATE own_tracks SET audio_object_id = NULL, updated_at = now() WHERE audio_object_id = ${id}`;
		await tx`UPDATE own_tracks SET cover_object_id = NULL WHERE cover_object_id = ${id}`;
		await tx`UPDATE dj_sets SET cover_object_id = NULL WHERE cover_object_id = ${id}`;
		await tx`DELETE FROM media_objects WHERE id = ${id}`;
	});
}

/** Files of a track/set that was just deleted from the database: remove them from storage too. */
export async function deleteOrphans(d: MediaDeps, ids: (string | null)[]): Promise<{ deleted: string[]; failed: string[] }> {
	const out = { deleted: [] as string[], failed: [] as string[] };
	for (const id of ids) {
		if (!id) continue;
		try {
			await deleteMedia(d, id);
			out.deleted.push(id);
		} catch {
			// Left as 'deleting'/'ready' for cleanupStale(); the track itself is gone either way.
			await d.sql`UPDATE media_objects SET status = 'deleting' WHERE id = ${id} AND status = 'ready'`.catch(() => undefined);
			out.failed.push(id);
		}
	}
	return out;
}

/**
 * Metadata cleanup: abort uploads unfinished for > 24 h, finish deletes that failed halfway, and drop
 * 'ready' files nothing refers to any more for > 24 h (an upload whose form was never saved).
 */
export async function cleanupStale(d: MediaDeps): Promise<{ aborted: number; deleted: number; orphans: number }> {
	const stale = await d.sql<Row[]>`SELECT * FROM media_objects WHERE status IN ('uploading', 'failed') AND created_at < now() - interval '24 hours'`;
	let aborted = 0;
	for (const r of stale) {
		try {
			if (r.upload_id) await d.store.abortMultipart(r.object_key, r.upload_id);
			else await d.store.delete(r.object_key);
			await d.sql`DELETE FROM media_objects WHERE id = ${r.id} AND status IN ('uploading', 'failed')`;
			aborted++;
		} catch {
			/* next time */
		}
	}
	const orphans = await d.sql<{ id: string }[]>`
		SELECT m.id FROM media_objects m
		WHERE m.status = 'ready' AND m.completed_at < now() - interval '24 hours'
		  AND NOT EXISTS (SELECT 1 FROM own_tracks t WHERE t.audio_object_id = m.id OR t.cover_object_id = m.id)
		  AND NOT EXISTS (SELECT 1 FROM dj_sets s WHERE s.audio_object_id = m.id OR s.cover_object_id = m.id)`;
	const pending = await d.sql<{ id: string }[]>`SELECT id FROM media_objects WHERE status = 'deleting'`;
	let deleted = 0;
	for (const { id } of [...pending, ...orphans]) {
		try {
			await deleteMedia(d, id);
			deleted++;
		} catch {
			/* next time */
		}
	}
	return { aborted, deleted, orphans: orphans.length };
}

/** A ready file of the right purpose (used when a track/set links its audio or cover). */
export async function requireReady(sql: Queryable, id: unknown, purpose: Purpose): Promise<string> {
	if (!isUuid(id)) throw new BadInput('Unknown file');
	const [r] = await sql<{ status: string; purpose: Purpose }[]>`SELECT status, purpose FROM media_objects WHERE id = ${id}`;
	if (!r) throw new BadInput('Unknown file');
	if (r.purpose !== purpose) throw new BadInput(`That file isn’t a ${purpose}`);
	if (r.status !== 'ready') throw new BadInput('That upload isn’t finished yet');
	return id;
}

export interface MediaFile {
	id: string;
	purpose: Purpose;
	name: string | null;
	size: number;
	status: UploadStatus['status'];
	contentType: string;
	createdAt: string;
	usedBy: string | null;
}
export async function listFiles(sql: Queryable): Promise<MediaFile[]> {
	const rows = await sql<(Row & { used_by: string | null })[]>`
		SELECT m.*, coalesce(
		  (SELECT 'Track: ' || title FROM own_tracks t WHERE t.audio_object_id = m.id OR t.cover_object_id = m.id LIMIT 1),
		  (SELECT 'Set: ' || title FROM dj_sets s WHERE s.audio_object_id = m.id OR s.cover_object_id = m.id LIMIT 1)) AS used_by
		FROM media_objects m ORDER BY m.size_bytes DESC, m.created_at DESC LIMIT 500`;
	return rows.map((r) => ({
		id: r.id,
		purpose: r.purpose,
		name: r.original_name,
		size: Number(r.size_bytes),
		status: r.status,
		contentType: r.content_type,
		createdAt: new Date(r.created_at).toISOString(),
		usedBy: r.used_by
	}));
}

export { maxBytes };
