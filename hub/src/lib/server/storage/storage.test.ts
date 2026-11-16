import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { createFakeS3 } from '../../../../e2e/mock/fake-s3.mjs';
import { canonicalQuery, presign, rfc3986, signHeaders } from './sigv4';
import { S3Storage, StorageError } from './s3';
import { storageConfigFrom } from './config';

const creds = { accessKeyId: 'fake-access', secretAccessKey: 'fake-secret' };
let server: Server;
let base: string;

let fake: import("../../../../e2e/mock/fake-s3.mjs").FakeS3;

beforeAll(async () => {
	fake = createFakeS3({ prefix: '/storage/v1/s3' });
	server = await fake.listen(0);
	const addr = server.address() as { port: number };
	base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

const store = (o: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) =>
	new S3Storage({ endpoint: `${base}/storage/v1/s3`, region: 'eu-central-1', bucket: 'rotor-media', creds, pathStyle: true, label: 'test', ...o });
const KEY = 'tracks/0b0c2c1e-6a58-4b1f-9d7e-1f2a3b4c5d6e.mp3';

describe('SigV4', () => {
	it('matches the AWS documented GET example (header signing)', () => {
		// AWS SigV4 test vector "GET Object" (s3 docs, examplebucket, 20130524).
		const h = signHeaders({
			method: 'GET',
			url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
			region: 'us-east-1',
			creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
			headers: { range: 'bytes=0-9' },
			now: new Date('2013-05-24T00:00:00Z')
		});
		expect(h.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
		);
	});
	it('matches the AWS documented presigned URL example', () => {
		const url = presign({
			method: 'GET',
			url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
			region: 'us-east-1',
			creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
			expiresS: 86400,
			now: new Date('2013-05-24T00:00:00Z')
		});
		expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
	});
	it('encodes like S3 (RFC 3986, sorted)', () => {
		expect(rfc3986("a b*'(")).toBe('a%20b%2A%27%28');
		expect(canonicalQuery(new URLSearchParams('uploads=&b=2&a=1'))).toBe('a=1&b=2&uploads=');
	});
});

describe('S3Storage against the fake', () => {
	it('single PUT via a presigned URL, HEAD, GET with Range, DELETE (idempotent)', async () => {
		const s = store();
		const body = Buffer.alloc(6 * 1024 * 1024, 7); // > 4.5 MB: never through Vercel
		const put = await fetch(s.presignPut(KEY, 60), { method: 'PUT', body });
		expect(put.status).toBe(200);
		expect(await s.head(KEY)).toMatchObject({ size: body.length });
		const get = await fetch(s.presignGet(KEY, 60), { headers: { Range: 'bytes=0-9' } });
		expect(get.status).toBe(206);
		await s.delete(KEY);
		await s.delete(KEY);
		expect(await s.head(KEY)).toBeNull();
	});

	it('multipart: parts, ListParts, complete, checksum intact', async () => {
		const s = store();
		const part = 5 * 1024 * 1024;
		const body = Buffer.concat([Buffer.alloc(part, 1), Buffer.alloc(part, 2), Buffer.alloc(1000, 3)]);
		const id = await s.createMultipart(KEY, 'audio/mpeg');
		const etags: { n: number; etag: string }[] = [];
		for (let n = 1; n <= 3; n++) {
			const r = await fetch(s.presignPart(KEY, id, n, 60), { method: 'PUT', body: body.subarray((n - 1) * part, Math.min(body.length, n * part)) });
			expect(r.status).toBe(200);
			etags.push({ n, etag: r.headers.get('etag')! });
		}
		expect((await s.listParts(KEY, id)).map((p) => p.n)).toEqual([1, 2, 3]);
		await s.completeMultipart(KEY, id, etags);
		const o = fake.objects.get(KEY)!;
		expect(createHash('sha256').update(o.body).digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
		expect(o.type).toBe('audio/mpeg');
		await s.delete(KEY);
	});

	it('refuses an expired presigned URL and a wrong secret', async () => {
		const t0 = new Date(Date.now() - 120_000);
		const old = store({ now: () => t0 });
		const r = await fetch(old.presignGet(KEY, 60));
		expect(r.status).toBe(403);
		expect(await r.text()).toContain('expired');
		const bad = store({ creds: { accessKeyId: 'fake-access', secretAccessKey: 'nope' } });
		await expect(bad.head(KEY)).rejects.toBeInstanceOf(StorageError);
	});

	it('abort removes a multipart upload; keys are validated', async () => {
		const s = store();
		const id = await s.createMultipart(KEY, 'audio/mpeg');
		await s.abortMultipart(KEY, id);
		expect(fake.uploads.has(id)).toBe(false);
		expect(() => s.presignGet('../etc/passwd', 60)).toThrow(StorageError);
	});
});

describe('storage config', () => {
	it('reports missing variables without values, applies limits', () => {
		const c = storageConfigFrom({ MEDIA_S3_ENDPOINT: 'https://x.storage.supabase.co/storage/v1/s3', MEDIA_MAX_SET_MB: '50', MEDIA_PART_MB: '1' });
		expect(c.configured).toBe(false);
		expect(c.missing).toEqual(['MEDIA_S3_REGION', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY']);
		expect(c.limits.setBytes).toBe(50 * 1048576);
		expect(c.limits.trackBytes).toBe(50 * 1048576);
		expect(c.limits.quotaBytes).toBe(1024 * 1048576);
		expect(c.limits.partBytes).toBe(5 * 1048576); // clamped to S3's minimum
		expect(c.endpointHost).toBe('x.storage.supabase.co');
	});
});
