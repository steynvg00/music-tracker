/**
 * Browser side of uploads (v0.94): the file goes straight to storage with short-lived signed URLs
 * (Vercel never sees the bytes, so its ~4.5 MB request limit can't be hit). Above one part's size
 * the upload is multipart: every part is its own signed PUT, reported to the server when done, so an
 * interrupted upload resumes where it stopped (same file picked again, even after a reload).
 */
import { apiDelete, apiGet, apiPost, apiPut } from '$lib/player/api-client';
import { partRange, remainingParts, type Purpose, type UploadStatus, type UploadTicket } from '$lib/shared/media';

export interface Progress {
	sent: number;
	total: number;
	pct: number;
	phase: 'starting' | 'uploading' | 'finishing' | 'done';
	resumed: boolean;
}

const RESUME = 'rotor.uploads.v1';
const fingerprint = (f: File, p: Purpose) => `${p}|${f.name}|${f.size}|${f.lastModified}`;

function loadResume(): Record<string, string> {
	try {
		return JSON.parse(localStorage.getItem(RESUME) ?? '{}') as Record<string, string>;
	} catch {
		return {};
	}
}
function saveResume(fp: string, id: string | null) {
	try {
		const m = loadResume();
		if (id) m[fp] = id;
		else delete m[fp];
		localStorage.setItem(RESUME, JSON.stringify(m));
	} catch {
		/* private mode: resume works within this page only */
	}
}
/** An unfinished upload of this exact file (same name, size, modified time)? */
export function pendingFor(f: File, p: Purpose): string | null {
	return loadResume()[fingerprint(f, p)] ?? null;
}

export class UploadAborted extends Error {
	constructor() {
		super('Upload cancelled');
		this.name = 'UploadAborted';
	}
}

/** PUT a blob with progress (XHR: fetch has no upload progress). Resolves with the ETag if readable. */
function put(url: string, body: Blob, onSent: (n: number) => void, signal: AbortSignal): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const x = new XMLHttpRequest();
		x.open('PUT', url);
		x.upload.onprogress = (e) => onSent(e.loaded);
		x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.getResponseHeader('ETag')) : reject(new Error(x.status === 403 ? 'Upload link expired or refused (403)' : `Storage answered ${x.status}`)));
		x.onerror = () => reject(new Error('Connection lost during upload'));
		x.onabort = () => reject(new UploadAborted());
		if (signal.aborted) return reject(new UploadAborted());
		signal.addEventListener('abort', () => x.abort(), { once: true });
		x.send(body);
	});
}

/**
 * Upload (or resume) `file`. Returns the media object id once storage has the whole file and the server
 * verified its size. `signal` cancels; the caller decides whether to also discard it (cancelUpload).
 */
export async function uploadFile(file: File, purpose: Purpose, opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal; concurrency?: number } = {}): Promise<string> {
	const signal = opts.signal ?? new AbortController().signal;
	const fp = fingerprint(file, purpose);
	const report = (p: Omit<Progress, 'pct'>) => opts.onProgress?.({ ...p, pct: p.total ? Math.min(100, Math.round((p.sent / p.total) * 100)) : 0 });
	let status: UploadStatus | null = null;
	const existing = pendingFor(file, purpose);
	if (existing) {
		status = await apiGet<UploadStatus>(`/api/media/uploads/${existing}`).catch(() => null);
		if (!status || status.status !== 'uploading' || status.size !== file.size) {
			if (status?.status === 'ready' && status.size === file.size) {
				saveResume(fp, null);
				return status.id;
			}
			status = null;
			saveResume(fp, null);
		}
	}
	const resumed = !!status;
	report({ sent: 0, total: file.size, phase: 'starting', resumed });
	let ticket: UploadTicket | null = null;
	if (!status) {
		ticket = await apiPost<UploadTicket>('/api/media/uploads', { purpose, name: file.name, size: file.size, type: file.type });
		saveResume(fp, ticket.id);
		status = { id: ticket.id, status: 'uploading', mode: ticket.mode, size: ticket.size, partSize: ticket.partSize, partCount: ticket.partCount, done: [], purpose, name: file.name };
	}
	const id = status.id;
	if (status.mode === 'single') {
		const url = ticket?.url ?? (await apiPost<{ urls: Record<number, string> }>(`/api/media/uploads/${id}/part-urls`, { parts: [1] })).urls[1]!;
		await put(url, file, (n) => report({ sent: n, total: file.size, phase: 'uploading', resumed }), signal);
	} else {
		const todo = remainingParts(status.partCount, status.done);
		const sentBy = new Map<number, number>();
		for (const n of status.done) {
			const [a, b] = partRange(n, file.size, status.partSize);
			sentBy.set(n, b - a);
		}
		const total = () => [...sentBy.values()].reduce((s, v) => s + v, 0);
		report({ sent: total(), total: file.size, phase: 'uploading', resumed });
		const queue = [...todo];
		const st = status;
		// A failed part stops new parts from starting; parts already in flight finish and are reported,
		// so a resume only sends what storage doesn't have yet. Cancel (signal) aborts everything.
		let stop = false;
		const run = async () => {
			while (queue.length && !stop) {
				if (signal.aborted) throw new UploadAborted();
				const batch = queue.splice(0, 1);
				const { urls } = await apiPost<{ urls: Record<number, string> }>(`/api/media/uploads/${id}/part-urls`, { parts: batch });
				for (const n of batch) {
					const [a, b] = partRange(n, file.size, st.partSize);
					const etag = await put(urls[n]!, file.slice(a, b), (x) => {
						sentBy.set(n, x);
						report({ sent: total(), total: file.size, phase: 'uploading', resumed });
					}, signal);
					sentBy.set(n, b - a);
					await apiPut(`/api/media/uploads/${id}/part-urls`, { n, etag: etag ?? '' });
				}
			}
		};
		const worker = () =>
			run().catch((e) => {
				stop = true;
				throw e;
			});
		const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, todo.length)) }, worker));
		const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
		if (failed) throw failed.reason;
	}
	report({ sent: file.size, total: file.size, phase: 'finishing', resumed });
	await apiPost<UploadStatus>(`/api/media/uploads/${id}/complete`);
	saveResume(fp, null);
	report({ sent: file.size, total: file.size, phase: 'done', resumed });
	return id;
}

/** Cancel and discard: abort in storage, forget the row and the resume note. */
export async function discardUpload(file: File, purpose: Purpose, id: string | null): Promise<void> {
	saveResume(fingerprint(file, purpose), null);
	if (id) await apiDelete(`/api/media/uploads/${id}`).catch(() => undefined);
}

/** Duration of an audio file, read by the browser from its metadata (no upload needed). */
export function readDuration(file: File, timeoutMs = 8000): Promise<number | null> {
	return new Promise((resolve) => {
		const a = document.createElement('audio');
		a.preload = 'metadata';
		const url = URL.createObjectURL(file);
		const done = (v: number | null) => {
			clearTimeout(t);
			URL.revokeObjectURL(url);
			a.removeAttribute('src');
			resolve(v);
		};
		const t = setTimeout(() => done(null), timeoutMs);
		a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration * 1000) : null);
		a.onerror = () => done(null);
		a.src = url;
	});
}
