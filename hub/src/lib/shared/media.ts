/**
 * Uploads (v0.94): allowed types, limits, multipart planning and storage usage. Pure; shared by the
 * upload UI, the server and the tests. Files go from the browser straight to storage through short-lived
 * signed URLs, never through Vercel (its ~4.5 MB request limit) and never into the database.
 */

export type Purpose = 'track' | 'set' | 'cover';

export interface StorageLimits {
	trackBytes: number;
	setBytes: number;
	coverBytes: number;
	quotaBytes: number;
	partBytes: number;
}

export const AUDIO_TYPES: Record<string, string> = {
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	flac: 'audio/flac',
	wav: 'audio/wav'
};
export const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
/** Browser-reported types we accept as the same thing. */
const MIME_ALIASES: Record<string, string> = {
	'audio/mp3': 'audio/mpeg',
	'audio/x-mp3': 'audio/mpeg',
	'audio/x-m4a': 'audio/mp4',
	'audio/m4a': 'audio/mp4',
	'audio/x-aac': 'audio/aac',
	'audio/aacp': 'audio/aac',
	'audio/x-flac': 'audio/flac',
	'audio/x-wav': 'audio/wav',
	'audio/wave': 'audio/wav',
	'audio/vnd.wave': 'audio/wav'
};

export const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.flac,.wav,audio/mpeg,audio/mp4,audio/aac,audio/flac,audio/wav';
export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';

export function extOf(name: string): string {
	const m = /\.([A-Za-z0-9]{2,5})$/.exec(name.trim());
	return m ? m[1]!.toLowerCase() : '';
}

export function maxBytes(p: Purpose, l: StorageLimits): number {
	return p === 'track' ? l.trackBytes : p === 'set' ? l.setBytes : l.coverBytes;
}

export const fmtMB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export type FileCheck = { ok: true; ext: string; contentType: string } | { ok: false; error: string };

/** Type + size check (client before the upload starts, server again before signing anything). */
export function checkFile(p: Purpose, f: { name: string; size: number; type?: string | null }, l: StorageLimits): FileCheck {
	const ext = extOf(f.name);
	const table = p === 'cover' ? IMAGE_TYPES : AUDIO_TYPES;
	const kinds = p === 'cover' ? 'JPG, PNG or WebP' : 'MP3, M4A, AAC, FLAC or WAV';
	const contentType = table[ext];
	if (!contentType) return { ok: false, error: `Only ${kinds} files` };
	const reported = (f.type ?? '').toLowerCase().split(';')[0]!.trim();
	const norm = MIME_ALIASES[reported] ?? reported;
	// An empty or generic type is fine (iOS often reports none for FLAC); a different real type is not.
	if (norm && norm !== 'application/octet-stream' && norm !== contentType && !(contentType === 'image/jpeg' && norm === 'image/jpg')) {
		return { ok: false, error: `That file says it is ${reported}, not ${kinds}` };
	}
	if (!Number.isFinite(f.size) || f.size <= 0) return { ok: false, error: 'That file is empty' };
	const max = maxBytes(p, l);
	if (f.size > max) return { ok: false, error: `${fmtMB(f.size)} is over the ${fmtMB(max)} limit for ${p === 'track' ? 'a track' : p === 'set' ? 'a set' : 'a cover'}` };
	return { ok: true, ext: ext === 'jpeg' ? 'jpg' : ext, contentType };
}

/** One signed PUT up to one part's size, multipart above it. */
export function uploadMode(size: number, partBytes: number): 'single' | 'multipart' {
	return size > partBytes ? 'multipart' : 'single';
}
export function partCount(size: number, partBytes: number): number {
	return Math.max(1, Math.ceil(size / partBytes));
}
/** Byte range [start, end) of part n (1-based). */
export function partRange(n: number, size: number, partBytes: number): [number, number] {
	const start = (n - 1) * partBytes;
	return [start, Math.min(size, start + partBytes)];
}
/** Parts still to send, given the ones storage already has. */
export function remainingParts(total: number, done: number[]): number[] {
	const have = new Set(done);
	const out: number[] = [];
	for (let n = 1; n <= total; n++) if (!have.has(n)) out.push(n);
	return out;
}

export interface Usage {
	usedBytes: number;
	quotaBytes: number;
	pct: number;
	/** ≥ 80 % of the quota. */
	warn: boolean;
	full: boolean;
	files: { track: number; set: number; cover: number };
	pending: number;
}
export const WARN_PCT = 80;
export function usage(usedBytes: number, quotaBytes: number, files: Usage['files'], pending: number): Usage {
	const pct = quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 1000) / 10 : 0;
	return { usedBytes, quotaBytes, pct, warn: pct >= WARN_PCT, full: usedBytes >= quotaBytes, files, pending };
}

/** What the upload API answers when a file is accepted. */
export interface UploadTicket {
	id: string;
	mode: 'single' | 'multipart';
	size: number;
	partSize: number;
	partCount: number;
	/** single: the signed PUT URL. */
	url: string | null;
	expiresAt: string;
}
export interface UploadStatus {
	id: string;
	status: 'uploading' | 'ready' | 'deleting' | 'failed';
	mode: 'single' | 'multipart';
	size: number;
	partSize: number;
	partCount: number;
	done: number[];
	purpose: Purpose;
	name: string | null;
}
export interface PlaybackUrl {
	url: string;
	expiresAt: string;
	contentType: string;
}
