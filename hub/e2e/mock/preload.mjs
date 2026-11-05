/**
 * Node preload for the E2E hub server (`node --import ./e2e/mock/preload.mjs …`).
 *
 * - Wraps globalThis.fetch: mocked hosts answer from spotify-mock.mjs, localhost passes
 *   through, ANY other host is refused (fail closed) and logged as `blocked`.
 * - Control server on 127.0.0.1:$E2E_MOCK_PORT for the Playwright tests (/__mock/*) and the
 *   Spotify API for the Python job runner (/v1/*, spotipy prefix).
 * - A GitHub `hub-jobs.yml` dispatch spawns e2e/run_job_mocked.py against the throwaway DB.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createMock } from './spotify-mock.mjs';

const STATE = process.env.E2E_SPOTIFY_STATE;
const PORT = Number(process.env.E2E_MOCK_PORT ?? 55433);
const REPO = process.env.E2E_REPO_ROOT;
const PUSH_LOG = process.env.E2E_PUSH_LOG;
const JOB_LOG = process.env.E2E_JOB_LOG;
if (!STATE || !REPO) throw new Error('E2E preload needs E2E_SPOTIFY_STATE and E2E_REPO_ROOT');

const mock = createMock(STATE);
const realFetch = globalThis.fetch;
const MOCKED = new Set(['api.spotify.com', 'accounts.spotify.com', 'api.github.com', 'www.googleapis.com', 'soundcloud.com']);
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseBody(raw) {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'string') return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return Object.fromEntries(new URLSearchParams(raw));
	}
}

globalThis.fetch = async (input, init = {}) => {
	const req = input instanceof Request ? input : null;
	const url = new URL(req ? req.url : String(input));
	if (LOCAL.has(url.hostname)) return realFetch(input, init);
	const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
	let raw = init.body;
	if (raw === undefined && req && method !== 'GET') raw = await req.clone().text();
	if (raw instanceof URLSearchParams) raw = raw.toString();
	const res = mock.handle({ method, url: url.href, body: parseBody(raw), who: 'hub' });
	if (res.blocked || !MOCKED.has(url.host)) throw new TypeError(`E2E: blocked external fetch to ${url.host}`);
	const headers = { 'content-type': 'application/json', ...(res.headers ?? {}) };
	return new Response(res.status === 204 || res.body === undefined ? null : JSON.stringify(res.body), { status: res.status, headers });
};

// GitHub dispatch → run the real Python job runner (mocked Spotify + push) a moment later,
// so the UI can be seen in its "queued" state first.
mock.onDispatch((workflow, inputs) => {
	if (workflow !== 'hub-jobs.yml') return;
	const delay = Number(process.env.E2E_JOB_DELAY_MS ?? 1200);
	setTimeout(() => {
		const args = ['run', '--no-sync', 'python', 'hub/e2e/run_job_mocked.py'];
		if (!inputs.job_id) args.push('--daily');
		const child = spawn('uv', args, {
			cwd: REPO,
			env: { ...process.env, JOB_ID: inputs.job_id ?? '', E2E_SPOTIFY_PREFIX: `http://127.0.0.1:${PORT}/v1/` },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const log = (b) => JOB_LOG && appendFileSync(JOB_LOG, b);
		child.stdout.on('data', log);
		child.stderr.on('data', log);
	}, delay);
});

const json = (res, status, body) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks).toString('utf8');
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
	if (url.pathname === '/__mock/calls') return json(res, 200, mock.calls());
	if (url.pathname === '/__mock/reset-calls') return (mock.resetCalls(), json(res, 200, { ok: true }));
	if (url.pathname === '/__mock/reset') return (mock.reset(), json(res, 200, { ok: true }));
	if (url.pathname === '/__mock/state' && req.method === 'GET') return json(res, 200, mock.state());
	if (url.pathname === '/__mock/state' && req.method === 'POST') return (mock.merge(JSON.parse(raw || '{}')), json(res, 200, { ok: true }));
	if (url.pathname === '/__mock/pushes') {
		const lines = PUSH_LOG && existsSync(PUSH_LOG) ? readFileSync(PUSH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
		return json(res, 200, lines);
	}
	// R4: the Python refresh's YouTube / SoundCloud calls (YOUTUBE_API_BASE / SOUNDCLOUD_OEMBED_URL).
	if (url.pathname.startsWith('/youtube/v3/') || url.pathname === '/oembed') {
		const host = url.pathname === '/oembed' ? 'soundcloud.com' : 'www.googleapis.com';
		const r = mock.handle({ method: 'GET', url: `https://${host}${url.pathname}${url.search}`, who: 'python' });
		res.writeHead(r.status, { 'content-type': 'application/json' });
		return res.end(JSON.stringify(r.body ?? {}));
	}
	if (url.pathname.startsWith('/v1/')) {
		const r = mock.handle({ method: req.method ?? 'GET', url: `https://api.spotify.com${url.pathname}${url.search}`, body: parseBody(raw || undefined), who: 'python' });
		res.writeHead(r.status, { 'content-type': 'application/json' });
		return res.end(r.status === 204 || r.body === undefined ? '' : JSON.stringify(r.body));
	}
	json(res, 404, { error: 'unknown mock route' });
}).listen(PORT, '127.0.0.1');
