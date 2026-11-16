/**
 * Storage configuration (v0.94), env vars only, so the backend can move (Supabase → your own server /
 * MinIO / R2) without a code change. Placeholders in /.env.example and hub/.env.example.
 *
 *   MEDIA_STORAGE_BACKEND       a label for Settings (supabase | minio | r2 | s3); behaviour doesn't depend on it
 *   MEDIA_S3_ENDPOINT           e.g. https://<project-ref>.storage.supabase.co/storage/v1/s3
 *   MEDIA_S3_REGION             e.g. eu-central-1 (Supabase: your project's region; R2: auto)
 *   MEDIA_S3_BUCKET             e.g. rotor-media (PRIVATE bucket)
 *   MEDIA_S3_ACCESS_KEY_ID      S3 access key (server-side only)
 *   MEDIA_S3_SECRET_ACCESS_KEY  S3 secret (server-side only)
 *   MEDIA_S3_PATH_STYLE         true (default; Supabase + MinIO need it) | false
 *   MEDIA_MAX_TRACK_MB=50  MEDIA_MAX_SET_MB=400  MEDIA_MAX_COVER_MB=5  MEDIA_QUOTA_MB=1024  MEDIA_PART_MB=8
 *   MEDIA_UPLOAD_URL_TTL_S=900  MEDIA_PLAYBACK_URL_TTL_S=600
 */
import { env } from '$env/dynamic/private';
import { S3Storage, type MediaStorage } from './s3';
import type { StorageLimits } from '$lib/shared/media';

export interface StorageConfig {
	configured: boolean;
	/** Which variables are missing (Settings shows them; never their values). */
	missing: string[];
	backend: string;
	endpointHost: string | null;
	bucket: string | null;
	region: string | null;
	pathStyle: boolean;
	limits: StorageLimits;
	uploadTtlS: number;
	playbackTtlS: number;
}

const MB = 1024 * 1024;

function num(e: Record<string, string | undefined>, name: string, dflt: number, min: number, max: number): number {
	const raw = e[name]?.trim();
	const v = raw ? Number(raw) : dflt;
	return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : dflt;
}

export function storageConfigFrom(e: Record<string, string | undefined>): StorageConfig & { accessKeyId: string | null; secretAccessKey: string | null; endpoint: string | null } {
	const get = (n: string) => e[n]?.trim() || null;
	const endpoint = get('MEDIA_S3_ENDPOINT');
	const required = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_REGION', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY'];
	const missing = required.filter((n) => !get(n));
	let endpointHost: string | null = null;
	try {
		endpointHost = endpoint ? new URL(endpoint).host : null;
	} catch {
		missing.push('MEDIA_S3_ENDPOINT (not a URL)');
	}
	return {
		configured: missing.length === 0,
		missing,
		backend: get('MEDIA_STORAGE_BACKEND') ?? 'supabase',
		endpoint,
		endpointHost,
		bucket: get('MEDIA_S3_BUCKET'),
		region: get('MEDIA_S3_REGION'),
		pathStyle: (get('MEDIA_S3_PATH_STYLE') ?? 'true').toLowerCase() !== 'false',
		accessKeyId: get('MEDIA_S3_ACCESS_KEY_ID'),
		secretAccessKey: get('MEDIA_S3_SECRET_ACCESS_KEY'),
		limits: {
			trackBytes: num(e, 'MEDIA_MAX_TRACK_MB', 50, 1, 5000) * MB,
			setBytes: num(e, 'MEDIA_MAX_SET_MB', 400, 1, 5000) * MB,
			coverBytes: num(e, 'MEDIA_MAX_COVER_MB', 5, 1, 50) * MB,
			quotaBytes: num(e, 'MEDIA_QUOTA_MB', 1024, 1, 1_000_000) * MB,
			// S3 needs ≥ 5 MiB for every part but the last.
			partBytes: num(e, 'MEDIA_PART_MB', 8, 5, 100) * MB
		},
		uploadTtlS: num(e, 'MEDIA_UPLOAD_URL_TTL_S', 900, 60, 3600),
		playbackTtlS: num(e, 'MEDIA_PLAYBACK_URL_TTL_S', 600, 2, 3600)
	};
}

export class StorageUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StorageUnavailable';
	}
}

let cached: ReturnType<typeof storageConfigFrom> | null = null;
let store: MediaStorage | null = null;

export function storageConfig(): StorageConfig {
	const { accessKeyId: _a, secretAccessKey: _s, endpoint: _e, ...pub } = (cached ??= storageConfigFrom(env));
	return pub;
}

/** The configured backend, or StorageUnavailable (Settings › Storage says which variables are missing). */
export function mediaStorage(): MediaStorage {
	if (store) return store;
	const c = (cached ??= storageConfigFrom(env));
	if (!c.configured) throw new StorageUnavailable(`Uploads need storage settings (${c.missing.join(', ')}). See Settings › Storage.`);
	return (store = new S3Storage({
		endpoint: c.endpoint!,
		region: c.region!,
		bucket: c.bucket!,
		creds: { accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! },
		pathStyle: c.pathStyle,
		label: c.backend
	}));
}
