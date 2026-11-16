/**
 * AWS Signature Version 4 for the S3 API (v0.94), no SDK: header signing for server-side calls and
 * query-string presigning for the browser's direct uploads/downloads. Works with every S3-compatible
 * backend (Supabase Storage's S3 endpoint, MinIO, Cloudflare R2, AWS S3).
 *
 * Only `host` is signed in presigned URLs, so the browser may send any Content-Type it likes; the object's
 * type is fixed when the upload is created (multipart) or checked by HEAD after a single PUT.
 */
import { createHash, createHmac } from 'node:crypto';

export interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED = 'UNSIGNED-PAYLOAD';

const sha256hex = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();

/** RFC 3986 encoding as S3 wants it (unreserved: A–Z a–z 0–9 - _ . ~). */
export function rfc3986(s: string): string {
	return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonical URI: each path segment encoded once, slashes kept. */
export function canonicalPath(pathname: string): string {
	return pathname
		.split('/')
		.map((seg) => rfc3986(decodeURIComponent(seg)))
		.join('/');
}

export function canonicalQuery(params: URLSearchParams): string {
	return [...params.entries()]
		.map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
}

export function amzDate(now: Date): { long: string; short: string } {
	const long = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
	return { long, short: long.slice(0, 8) };
}

function signingKey(secret: string, short: string, region: string, service: string): Buffer {
	return hmac(hmac(hmac(hmac(`AWS4${secret}`, short), region), service), 'aws4_request');
}

function hostOf(u: URL): string {
	return u.host; // includes a non-default port
}

/** Sign a request with an Authorization header. Returns the headers to send. */
export function signHeaders(opts: {
	method: string;
	url: URL;
	region: string;
	creds: Credentials;
	headers?: Record<string, string>;
	payloadHash?: string;
	now?: Date;
	service?: string;
}): Record<string, string> {
	const now = opts.now ?? new Date();
	const service = opts.service ?? 's3';
	const { long, short } = amzDate(now);
	const payloadHash = opts.payloadHash ?? EMPTY_SHA256;
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = String(v).trim();
	headers['host'] = hostOf(opts.url);
	headers['x-amz-date'] = long;
	headers['x-amz-content-sha256'] = payloadHash;
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.replace(/\s+/g, ' ')}\n`).join('');
	const signed = names.join(';');
	const canonical = [opts.method.toUpperCase(), canonicalPath(opts.url.pathname), canonicalQuery(opts.url.searchParams), canonicalHeaders, signed, payloadHash].join('\n');
	const scope = `${short}/${opts.region}/${service}/aws4_request`;
	const toSign = ['AWS4-HMAC-SHA256', long, scope, sha256hex(canonical)].join('\n');
	const signature = createHmac('sha256', signingKey(opts.creds.secretAccessKey, short, opts.region, service)).update(toSign).digest('hex');
	const out = { ...headers };
	delete out['host'];
	out['authorization'] = `AWS4-HMAC-SHA256 Credential=${opts.creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
	return out;
}

/** A presigned URL (query-string auth), valid for `expiresS` seconds (1 s … 7 days). */
export function presign(opts: { method: string; url: URL; region: string; creds: Credentials; expiresS: number; now?: Date; service?: string }): string {
	const now = opts.now ?? new Date();
	const service = opts.service ?? 's3';
	const { long, short } = amzDate(now);
	const scope = `${short}/${opts.region}/${service}/aws4_request`;
	const u = new URL(opts.url.href);
	u.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
	u.searchParams.set('X-Amz-Credential', `${opts.creds.accessKeyId}/${scope}`);
	u.searchParams.set('X-Amz-Date', long);
	u.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604800, Math.floor(opts.expiresS)))));
	u.searchParams.set('X-Amz-SignedHeaders', 'host');
	const canonical = [opts.method.toUpperCase(), canonicalPath(u.pathname), canonicalQuery(u.searchParams), `host:${hostOf(u)}\n`, 'host', UNSIGNED].join('\n');
	const toSign = ['AWS4-HMAC-SHA256', long, scope, sha256hex(canonical)].join('\n');
	const signature = createHmac('sha256', signingKey(opts.creds.secretAccessKey, short, opts.region, service)).update(toSign).digest('hex');
	u.searchParams.set('X-Amz-Signature', signature);
	// URLSearchParams encodes spaces as '+'; S3 wants %20 (the canonical form we signed).
	return `${u.origin}${u.pathname}?${canonicalQuery(u.searchParams)}`;
}

export { sha256hex };
