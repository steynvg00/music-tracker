/**
 * The one storage interface (v0.94) and its S3-compatible implementation. Every backend Rotor supports
 * speaks the S3 API: a PRIVATE Supabase Storage bucket by default (its S3 endpoint), or your own MinIO,
 * Cloudflare R2 or AWS S3 — switching is env vars only (see ./config.ts and the PR's setup steps).
 *
 * Object keys are backend-independent (`tracks/<uuid>.mp3`), so the database never needs to change when
 * the backend does; scripts/migrate_media_storage.py copies the objects and verifies their checksums.
 */
import { presign, signHeaders, sha256hex, type Credentials } from './sigv4';

export interface PartInfo {
	n: number;
	etag: string;
	size: number | null;
}
export interface HeadInfo {
	size: number;
	contentType: string | null;
	etag: string | null;
}

/** What the rest of Rotor may do with stored files. Nothing else talks to storage. */
export interface MediaStorage {
	readonly label: string;
	presignPut(key: string, expiresS: number): string;
	presignGet(key: string, expiresS: number): string;
	createMultipart(key: string, contentType: string): Promise<string>;
	presignPart(key: string, uploadId: string, partNumber: number, expiresS: number): string;
	listParts(key: string, uploadId: string): Promise<PartInfo[]>;
	completeMultipart(key: string, uploadId: string, parts: { n: number; etag: string }[]): Promise<void>;
	abortMultipart(key: string, uploadId: string): Promise<void>;
	head(key: string): Promise<HeadInfo | null>;
	/** Idempotent: deleting a missing object succeeds. */
	delete(key: string): Promise<void>;
}

export class StorageError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null,
		readonly code: string | null = null
	) {
		super(message);
		this.name = 'StorageError';
	}
}

export interface S3Options {
	endpoint: string;
	region: string;
	bucket: string;
	creds: Credentials;
	/** Path-style URLs (endpoint/bucket/key). Supabase and MinIO need it; R2/AWS work either way. */
	pathStyle: boolean;
	label: string;
	fetch?: typeof fetch;
	now?: () => Date;
}

const xmlTag = (xml: string, tag: string): string | null => {
	const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	return m ? decodeXml(m[1]!) : null;
};
const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const encodeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const KEY_RE = /^(tracks|sets|covers)\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export class S3Storage implements MediaStorage {
	readonly label: string;
	#o: S3Options;
	#fetch: typeof fetch;
	constructor(o: S3Options) {
		this.#o = { ...o, endpoint: o.endpoint.replace(/\/+$/, '') };
		this.label = o.label;
		this.#fetch = o.fetch ?? ((...a) => fetch(...a));
	}

	objectUrl(key: string): URL {
		if (!KEY_RE.test(key)) throw new StorageError(`Refusing an unexpected object key: ${key.slice(0, 80)}`);
		const e = new URL(this.#o.endpoint);
		if (this.#o.pathStyle) return new URL(`${e.origin}${e.pathname.replace(/\/+$/, '')}/${this.#o.bucket}/${key}`);
		return new URL(`${e.protocol}//${this.#o.bucket}.${e.host}${e.pathname.replace(/\/+$/, '')}/${key}`);
	}

	#now() {
		return this.#o.now?.() ?? new Date();
	}

	async #send(method: string, url: URL, body?: string, headers: Record<string, string> = {}): Promise<Response> {
		const signed = signHeaders({ method, url, region: this.#o.region, creds: this.#o.creds, headers, payloadHash: sha256hex(body ?? ''), now: this.#now() });
		let res: Response;
		try {
			res = await this.#fetch(url.href, { method, headers: signed, body, signal: AbortSignal.timeout(20_000) });
		} catch (e) {
			throw new StorageError(`Storage is unreachable (${e instanceof Error ? e.message : String(e)})`);
		}
		return res;
	}

	async #fail(res: Response, what: string): Promise<never> {
		const text = await res.text().catch(() => '');
		throw new StorageError(`${what}: storage answered ${res.status}${xmlTag(text, 'Message') ? ` (${xmlTag(text, 'Message')})` : ''}`, res.status, xmlTag(text, 'Code'));
	}

	presignPut(key: string, expiresS: number): string {
		return presign({ method: 'PUT', url: this.objectUrl(key), region: this.#o.region, creds: this.#o.creds, expiresS, now: this.#now() });
	}

	presignGet(key: string, expiresS: number): string {
		return presign({ method: 'GET', url: this.objectUrl(key), region: this.#o.region, creds: this.#o.creds, expiresS, now: this.#now() });
	}

	presignPart(key: string, uploadId: string, partNumber: number, expiresS: number): string {
		const u = this.objectUrl(key);
		u.searchParams.set('partNumber', String(partNumber));
		u.searchParams.set('uploadId', uploadId);
		return presign({ method: 'PUT', url: u, region: this.#o.region, creds: this.#o.creds, expiresS, now: this.#now() });
	}

	async createMultipart(key: string, contentType: string): Promise<string> {
		const u = this.objectUrl(key);
		u.searchParams.set('uploads', '');
		const res = await this.#send('POST', u, '', { 'content-type': contentType });
		if (!res.ok) return this.#fail(res, 'Starting the upload failed');
		const id = xmlTag(await res.text(), 'UploadId');
		if (!id) throw new StorageError('Starting the upload failed: no UploadId in the answer');
		return id;
	}

	async listParts(key: string, uploadId: string): Promise<PartInfo[]> {
		const out: PartInfo[] = [];
		let marker = '';
		for (let page = 0; page < 50; page++) {
			const u = this.objectUrl(key);
			u.searchParams.set('uploadId', uploadId);
			if (marker) u.searchParams.set('part-number-marker', marker);
			const res = await this.#send('GET', u);
			if (!res.ok) return this.#fail(res, 'Listing the uploaded parts failed');
			const xml = await res.text();
			for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
				const n = Number(xmlTag(m[1]!, 'PartNumber'));
				const etag = xmlTag(m[1]!, 'ETag');
				const size = Number(xmlTag(m[1]!, 'Size'));
				if (n && etag) out.push({ n, etag, size: Number.isFinite(size) ? size : null });
			}
			if (xmlTag(xml, 'IsTruncated') !== 'true') break;
			marker = xmlTag(xml, 'NextPartNumberMarker') ?? '';
			if (!marker) break;
		}
		return out.sort((a, b) => a.n - b.n);
	}

	async completeMultipart(key: string, uploadId: string, parts: { n: number; etag: string }[]): Promise<void> {
		const u = this.objectUrl(key);
		u.searchParams.set('uploadId', uploadId);
		const body =
			'<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
			[...parts]
				.sort((a, b) => a.n - b.n)
				.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${encodeXml(p.etag)}</ETag></Part>`)
				.join('') +
			'</CompleteMultipartUpload>';
		const res = await this.#send('POST', u, body, { 'content-type': 'application/xml' });
		// S3 can answer 200 with an <Error> body for a failed complete.
		const text = res.ok ? await res.text() : '';
		if (!res.ok) return this.#fail(res, 'Finishing the upload failed');
		if (/<Error>/.test(text)) throw new StorageError(`Finishing the upload failed: ${xmlTag(text, 'Message') ?? xmlTag(text, 'Code') ?? 'error'}`, 200, xmlTag(text, 'Code'));
	}

	async abortMultipart(key: string, uploadId: string): Promise<void> {
		const u = this.objectUrl(key);
		u.searchParams.set('uploadId', uploadId);
		const res = await this.#send('DELETE', u);
		if (!res.ok && res.status !== 404) return this.#fail(res, 'Cancelling the upload failed');
	}

	async head(key: string): Promise<HeadInfo | null> {
		const res = await this.#send('HEAD', this.objectUrl(key));
		if (res.status === 404) return null;
		if (!res.ok) return this.#fail(res, 'Checking the file failed');
		return { size: Number(res.headers.get('content-length') ?? 0), contentType: res.headers.get('content-type'), etag: res.headers.get('etag') };
	}

	async delete(key: string): Promise<void> {
		const res = await this.#send('DELETE', this.objectUrl(key));
		if (!res.ok && res.status !== 404) return this.#fail(res, 'Deleting the file failed');
	}
}
