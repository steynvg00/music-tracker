/**
 * In-process fake of an S3-compatible object store (v0.94), for vitest and the E2E run. No real storage
 * is ever contacted. It checks what a real backend checks, so the tests prove the signing is right:
 *   - AWS SigV4: Authorization header (server calls) and presigned query auth (browser), incl. expiry
 *   - multipart: CreateMultipartUpload, UploadPart, ListParts, CompleteMultipartUpload (ETags must match,
 *     every part but the last ≥ 5 MiB), AbortMultipartUpload
 *   - PutObject, GetObject (Range), HeadObject, DeleteObject, ListObjectsV2
 *   - CORS for the browser (ETag exposed unless hideEtag)
 * Control (tests): POST /__fake/control {failPart, hideEtag, clockSkewS}, GET /__fake/objects, POST /__fake/reset.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const MIN_PART = 5 * 1024 * 1024;
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const md5 = (b) => createHash('md5').update(b).digest('hex');
const canonPath = (p) => p.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
const canonQuery = (params, skip) =>
	[...params.entries()]
		.filter(([k]) => k !== skip)
		.map(([k, v]) => [enc(k), enc(v)])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
const keyFor = (secret, short, region) => hmac(hmac(hmac(hmac(`AWS4${secret}`, short), region), 's3'), 'aws4_request');
const parseAmz = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

export function createFakeS3({ accessKeyId = 'fake-access', secretAccessKey = 'fake-secret', region = 'eu-central-1', bucket = 'rotor-media', prefix = '' } = {}) {
	const objects = new Map(); // key → { body: Buffer, type, etag }
	const uploads = new Map(); // uploadId → { key, type, parts: Map<n, {body, etag}> }
	const control = { failPart: 0, hideEtag: false, clockSkewS: 0, log: [] };
	const now = () => new Date(Date.now() + control.clockSkewS * 1000);

	function verify(req, url, bodyHash) {
		const q = url.searchParams;
		if (q.get('X-Amz-Algorithm')) {
			const cred = q.get('X-Amz-Credential') ?? '';
			const [ak, short, reg] = cred.split('/');
			if (ak !== accessKeyId || reg !== region) return 'InvalidAccessKeyId';
			const date = q.get('X-Amz-Date') ?? '';
			const exp = Number(q.get('X-Amz-Expires'));
			if (now().getTime() > parseAmz(date).getTime() + exp * 1000) return 'AccessDenied: Request has expired';
			const signed = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
			const headers = signed.map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`).join('');
			const canonical = [req.method, canonPath(url.pathname), canonQuery(q, 'X-Amz-Signature'), headers, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
			const toSign = ['AWS4-HMAC-SHA256', date, `${short}/${reg}/s3/aws4_request`, sha(canonical)].join('\n');
			const sig = createHmac('sha256', keyFor(secretAccessKey, short, reg)).update(toSign).digest('hex');
			return sig === q.get('X-Amz-Signature') ? null : 'SignatureDoesNotMatch';
		}
		const auth = req.headers['authorization'] ?? '';
		const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
		if (!m) return 'AccessDenied: no signature';
		const [, ak, short, reg, signedList, sig] = m;
		if (ak !== accessKeyId || reg !== region) return 'InvalidAccessKeyId';
		const date = String(req.headers['x-amz-date'] ?? '');
		if (Math.abs(now().getTime() - parseAmz(date).getTime()) > 15 * 60_000) return 'RequestTimeTooSkewed';
		if (req.headers['x-amz-content-sha256'] !== bodyHash) return 'XAmzContentSHA256Mismatch';
		const signed = signedList.split(';');
		const headers = signed.map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
		const canonical = [req.method, canonPath(url.pathname), canonQuery(url.searchParams), headers, signedList, bodyHash].join('\n');
		const toSign = ['AWS4-HMAC-SHA256', date, `${short}/${reg}/s3/aws4_request`, sha(canonical)].join('\n');
		const want = createHmac('sha256', keyFor(secretAccessKey, short, reg)).update(toSign).digest('hex');
		return want === sig ? null : 'SignatureDoesNotMatch';
	}

	const cors = (req) => ({
		'Access-Control-Allow-Origin': req.headers.origin ?? '*',
		'Access-Control-Allow-Methods': 'GET, PUT, HEAD, POST, DELETE',
		'Access-Control-Allow-Headers': '*',
		'Access-Control-Expose-Headers': control.hideEtag ? 'Content-Length' : 'ETag, Content-Length',
		'Access-Control-Max-Age': '600'
	});
	const xml = (res, req, status, body, extra = {}) => {
		res.writeHead(status, { 'content-type': 'application/xml', ...cors(req), ...extra });
		res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
	};
	const err = (res, req, status, code, msg = code) => xml(res, req, status, `<Error><Code>${code.split(':')[0]}</Code><Message>${msg}</Message></Error>`);

	async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://fake');
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		if (req.method === 'OPTIONS') return (res.writeHead(204, cors(req)), res.end());
		if (url.pathname === '/__fake/control' && req.method === 'POST') {
			Object.assign(control, JSON.parse(body.toString() || '{}'));
			return (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ ok: true })));
		}
		if (url.pathname === '/__fake/objects') {
			const list = [...objects].map(([k, o]) => ({ key: k, size: o.body.length, type: o.type, sha256: sha(o.body) }));
			return (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ objects: list, uploads: uploads.size, log: control.log.slice(-200) })));
		}
		if (url.pathname === '/__fake/reset') {
			objects.clear();
			uploads.clear();
			Object.assign(control, { failPart: 0, hideEtag: false, clockSkewS: 0, log: [] });
			return (res.writeHead(200), res.end('{}'));
		}
		const base = `${prefix}/${bucket}`;
		if (!url.pathname.startsWith(base)) return err(res, req, 404, 'NoSuchBucket');
		const key = decodeURIComponent(url.pathname.slice(base.length + 1));
		const problem = verify(req, url, req.headers['authorization'] ? sha(body) : 'UNSIGNED-PAYLOAD');
		control.log.push(`${req.method} ${key || '/'}${url.searchParams.has('partNumber') ? ` part=${url.searchParams.get('partNumber')}` : url.search.includes('uploadId') ? ' (multipart)' : ''}${problem ? ` → ${problem}` : ''}`);
		if (problem) return err(res, req, 403, problem.split(':')[0], problem);
		const q = url.searchParams;

		if (!key && req.method === 'GET' && q.get('list-type') === '2') {
			const pre = q.get('prefix') ?? '';
			const items = [...objects].filter(([k]) => k.startsWith(pre)).sort();
			return xml(res, req, 200, `<ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${items.map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><ETag>"${o.etag}"</ETag></Contents>`).join('')}</ListBucketResult>`);
		}
		if (req.method === 'POST' && q.has('uploads')) {
			const id = randomUUID();
			uploads.set(id, { key, type: req.headers['content-type'] ?? 'application/octet-stream', parts: new Map() });
			return xml(res, req, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
		}
		if (q.has('uploadId')) {
			const up = uploads.get(q.get('uploadId'));
			if (!up || up.key !== key) return err(res, req, 404, 'NoSuchUpload');
			if (req.method === 'PUT') {
				const n = Number(q.get('partNumber'));
				if (control.failPart && control.failPart === n) {
					// Interrupt once (resume test). A 500, not a dropped socket: browsers silently retry a reset
					// on a reused connection, which would make the test flaky.
					control.failPart = 0;
					return err(res, req, 500, 'InternalError', 'E2E: part refused once');
				}
				const etag = `"${md5(body)}"`;
				up.parts.set(n, { body, etag });
				res.writeHead(200, { ETag: etag, ...cors(req) });
				return res.end();
			}
			if (req.method === 'GET') {
				const parts = [...up.parts].sort((a, b) => a[0] - b[0]);
				return xml(res, req, 200, `<ListPartsResult><Key>${key}</Key><UploadId>${q.get('uploadId')}</UploadId><IsTruncated>false</IsTruncated>${parts.map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag.replace(/"/g, '&quot;')}</ETag><Size>${p.body.length}</Size></Part>`).join('')}</ListPartsResult>`);
			}
			if (req.method === 'DELETE') {
				uploads.delete(q.get('uploadId'));
				return (res.writeHead(204, cors(req)), res.end());
			}
			if (req.method === 'POST') {
				const want = [...body.toString().matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g)].map((m) => ({ n: Number(m[1]), etag: m[2].replace(/&quot;/g, '"') }));
				if (!want.length) return err(res, req, 400, 'MalformedXML');
				const bufs = [];
				for (let i = 0; i < want.length; i++) {
					const p = up.parts.get(want[i].n);
					if (!p || p.etag !== want[i].etag) return err(res, req, 400, 'InvalidPart');
					if (i < want.length - 1 && p.body.length < MIN_PART) return err(res, req, 400, 'EntityTooSmall');
					bufs.push(p.body);
				}
				const all = Buffer.concat(bufs);
				objects.set(key, { body: all, type: up.type, etag: `${md5(all)}-${want.length}` });
				uploads.delete(q.get('uploadId'));
				return xml(res, req, 200, `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"${md5(all)}-${want.length}"</ETag></CompleteMultipartUploadResult>`);
			}
		}
		if (req.method === 'PUT') {
			objects.set(key, { body, type: req.headers['content-type'] ?? 'application/octet-stream', etag: md5(body) });
			res.writeHead(200, { ETag: `"${md5(body)}"`, ...cors(req) });
			return res.end();
		}
		const o = objects.get(key);
		if (req.method === 'DELETE') {
			objects.delete(key);
			return (res.writeHead(204, cors(req)), res.end());
		}
		if (!o) return req.method === 'HEAD' ? (res.writeHead(404, cors(req)), res.end()) : err(res, req, 404, 'NoSuchKey');
		const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
		const head = { 'Content-Type': o.type, ETag: `"${o.etag}"`, 'Accept-Ranges': 'bytes', ...cors(req) };
		if (req.method === 'HEAD') return (res.writeHead(200, { ...head, 'Content-Length': o.body.length }), res.end());
		if (range) {
			const start = Number(range[1]);
			const end = range[2] ? Math.min(Number(range[2]), o.body.length - 1) : o.body.length - 1;
			res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${o.body.length}`, 'Content-Length': end - start + 1 });
			return res.end(o.body.subarray(start, end + 1));
		}
		res.writeHead(200, { ...head, 'Content-Length': o.body.length });
		res.end(o.body);
	}

	return {
		control,
		objects,
		uploads,
		handle,
		listen(port, host = '127.0.0.1') {
			const server = createServer((req, res) => {
				handle(req, res).catch((e) => {
					res.writeHead(500);
					res.end(String(e));
				});
			});
			return new Promise((ok) => server.listen(port, host, () => ok(server)));
		}
	};
}
