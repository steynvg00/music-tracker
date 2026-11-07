#!/usr/bin/env node
/**
 * Rotor local end-to-end run (R3+). Everything is throwaway and local:
 *   1. a fresh Postgres 16 cluster in hub/e2e/.out/pgdata (port 55432, trust auth, TZ UTC like Supabase)
 *   2. migrations 0001…E2E_MAX_MIGRATION applied in order; seed (hub/e2e/seed.py) runs before 0023 so
 *      the rollups are created on a populated database, like production
 *   3. `vite build`, then `vite preview` with every external service mocked (e2e/mock/preload.mjs)
 *   4. Playwright (iPhone 14 + laptop 1440×900) → e2e/.out/results.json → pass/fail table
 *   5. teardown: preview killed, Postgres stopped, data dir removed
 *
 *   npm run e2e                     # all specs
 *   E2E_GREP=R3 npm run e2e         # a subset
 *   PG_BIN=/path/to/pg16/bin npm run e2e
 *
 * A control endpoint on 127.0.0.1:55434 lets the service-worker spec simulate a new deploy:
 * POST /redeploy rebuilds the hub (new SvelteKit version) and restarts the server.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(HUB, '..');
const OUT = join(HUB, 'e2e', '.out');
const PG_BIN = process.env.PG_BIN ?? ['/usr/local/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@16/bin'].find((p) => existsSync(join(p, 'initdb')));
const PG_PORT = 55432;
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 47173);
const CTL_PORT = 55434;
const MAX_MIGRATION = Number(process.env.E2E_MAX_MIGRATION ?? 99);
const DB = `postgresql://postgres@127.0.0.1:${PG_PORT}/rotor_e2e`;

if (!PG_BIN) {
	console.error('No Postgres 16 found. Install it with: brew install postgresql@16  (or set PG_BIN)');
	process.exit(2);
}
const pg = (bin) => join(PG_BIN, bin);
// LC_ALL: Homebrew's Postgres refuses to start on macOS without a valid locale ("postmaster became multithreaded").
process.env.LC_ALL ??= 'en_US.UTF-8';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 1. Postgres ──
sh(pg('initdb'), ['-D', join(OUT, 'pgdata'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '-c', 'timezone=UTC'], { stdio: 'ignore' });
sh(pg('pg_ctl'), ['-D', join(OUT, 'pgdata'), '-o', `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, '-l', join(OUT, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
let preview = null;
const stopAll = () => {
	try {
		preview?.kill('SIGTERM');
	} catch {}
	try {
		execFileSync(pg('pg_ctl'), ['-D', join(OUT, 'pgdata'), '-m', 'fast', 'stop'], { stdio: 'ignore' });
	} catch {}
};
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

try {
	sh(pg('createdb'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', 'rotor_e2e']);
	const migrations = readdirSync(join(REPO, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
	const apply = (f) => sh(pg('psql'), ['-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', join(REPO, 'migrations', f)], { stdio: ['ignore', 'ignore', 'inherit'] });
	const before = migrations.filter((f) => Number(f.slice(0, 4)) <= 22 && Number(f.slice(0, 4)) <= MAX_MIGRATION);
	const after = migrations.filter((f) => Number(f.slice(0, 4)) > 22 && Number(f.slice(0, 4)) <= MAX_MIGRATION);
	for (const f of before) apply(f);
	console.log(`[e2e] applied ${before.length} migrations up to ${before.at(-1)}`);
	sh('uv', ['run', '--no-sync', 'python', 'hub/e2e/seed.py', '--db', DB, '--state', join(OUT, 'spotify-state.json'), '--plays', process.env.E2E_PLAYS ?? '30000'], { cwd: REPO });
	for (const f of after) {
		const t = Date.now();
		apply(f);
		console.log(`[e2e] applied ${f} on the seeded DB in ${Date.now() - t} ms`);
	}
	const applied = execFileSync(pg('psql'), ['-At', '-d', DB, '-c', 'SELECT string_agg(number::text, \',\' ORDER BY number) FROM migrations_applied'], { encoding: 'utf8' }).trim();
	console.log(`[e2e] migrations_applied: ${applied}`);
	writeFileSync(join(OUT, 'migrations.txt'), applied);

	// ── 3. hub ──
	const env = {
		...process.env,
		ORIGIN: `http://localhost:${APP_PORT}`,
		SPOTIFY_CLIENT_ID: 'e2e-hub-client',
		SPOTIFY_CLIENT_SECRET: 'e2e-hub-secret',
		SPOTIFY_CRON_CLIENT_ID: 'e2e-cron-client',
		SPOTIFY_CRON_CLIENT_SECRET: 'e2e-cron-secret',
		OWNER_SPOTIFY_ID: 'e2eowner',
		DATABASE_URL: DB,
		SESSION_SECRET: Buffer.alloc(32, 7).toString('base64'),
		TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
		GITHUB_DISPATCH_TOKEN: 'e2e-dispatch-token',
		GITHUB_REPOSITORY: 'steynvg00/music-tracker',
		VAPID_PUBLIC_KEY: 'BKEp-E2E-placeholder-public-key-not-real-0000000000000000000000000000000000000000000',
		YOUTUBE_API_KEY: 'e2e-youtube-key',
		YOUTUBE_API_BASE: 'http://127.0.0.1:55433/youtube/v3',
		SOUNDCLOUD_OEMBED_URL: 'http://127.0.0.1:55433/oembed',
		E2E_SPOTIFY_STATE: join(OUT, 'spotify-state.json'),
		E2E_MOCK_PORT: '55433',
		E2E_REPO_ROOT: REPO,
		E2E_PUSH_LOG: join(OUT, 'pushes.jsonl'),
		E2E_JOB_LOG: join(OUT, 'jobs.log')
	};
	const build = (dir = HUB) => sh('npx', ['vite', 'build'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'inherit'] });
	// v0.83.1: an OLD release (git tag) built in its own worktree, served on the same origin, so
	// the service-worker upgrade path from that release to this code can be tested for real.
	const legacy = new Map();
	const legacyBuild = (ref) => {
		if (legacy.has(ref)) return legacy.get(ref);
		if (!/^[\w./-]+$/.test(ref)) throw new Error(`bad ref ${ref}`);
		const wt = join(OUT, 'legacy', ref.replace(/[^\w.-]/g, '_'));
		sh('git', ['worktree', 'add', '--force', '--detach', wt, `refs/tags/${ref}`], { cwd: REPO, stdio: 'ignore' });
		const hub = join(wt, 'hub');
		sh('ln', ['-s', join(HUB, 'node_modules'), join(hub, 'node_modules')]);
		const t = Date.now();
		build(hub);
		console.log(`[e2e] built legacy ${ref} in ${Date.now() - t} ms`);
		legacy.set(ref, hub);
		return hub;
	};
	let servingDir = HUB;
	const start = (dir = servingDir) =>
		new Promise((ok, fail) => {
			servingDir = dir;
			preview = spawn(process.execPath, ['--import', join(HUB, 'e2e', 'mock', 'preload.mjs'), join(HUB, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(APP_PORT), '--strictPort'], {
				cwd: dir,
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			const logs = [];
			const onData = (b) => {
				logs.push(b.toString());
				if (/localhost:\d+/.test(b.toString())) ok();
			};
			preview.stdout.on('data', onData);
			preview.stderr.on('data', (b) => logs.push(b.toString()));
			if (process.env.E2E_DEBUG_PREVIEW) preview.stdout.on('data', (b) => console.log(`[preview] ${JSON.stringify(b.toString())}`));
			preview.on('exit', (c) => c && fail(new Error(`preview exited ${c}: ${logs.join('')}`)));
			setTimeout(() => fail(new Error('preview did not start')), 30_000);
		});
	const stopPreview = () =>
		new Promise((ok) => {
			if (!preview || preview.exitCode !== null) return ok();
			preview.once('exit', ok);
			preview.kill('SIGTERM');
		});
	const t0 = Date.now();
	build();
	console.log(`[e2e] vite build ${Date.now() - t0} ms`);
	await start();
	console.log(`[e2e] hub on http://localhost:${APP_PORT} (external services mocked)`);

	const ctl = createServer(async (req, res) => {
		if (req.url === '/redeploy' && req.method === 'POST') {
			await stopPreview();
			build();
			await start(HUB);
			res.writeHead(200).end('redeployed');
			return;
		}
		if (req.url?.startsWith('/deploy') && req.method === 'POST') {
			// /deploy?ref=<tag> → serve that old release; /deploy → serve this code again (no rebuild).
			const ref = new URL(req.url, 'http://ctl').searchParams.get('ref');
			try {
				const dir = ref ? legacyBuild(ref) : HUB;
				console.log(`[e2e] deploy ${ref ?? 'current'}: stopping preview`);
				await stopPreview();
				console.log(`[e2e] deploy ${ref ?? 'current'}: starting preview in ${dir}`);
				await start(dir);
				console.log(`[e2e] deploy ${ref ?? 'current'}: serving`);
				res.writeHead(200).end(`serving ${ref ?? 'current'}`);
			} catch (e) {
				res.writeHead(500).end(String(e));
			}
			return;
		}
		res.writeHead(404).end();
	}).listen(CTL_PORT, '127.0.0.1');

	// ── 4. Playwright ──
	const pw = spawn('npx', ['playwright', 'test', '-c', 'e2e/playwright.config.ts', ...(process.env.E2E_GREP ? ['-g', process.env.E2E_GREP] : [])], {
		cwd: HUB,
		env: { ...env, E2E_BASE_URL: `http://localhost:${APP_PORT}`, E2E_OUT: OUT, E2E_DB: DB, E2E_CTL: `http://127.0.0.1:${CTL_PORT}`, PG_BIN },
		stdio: 'inherit'
	});
	const code = await new Promise((ok) => pw.on('exit', ok));
	ctl.close();

	// ── results table ──
	const resultsFile = join(OUT, 'results.json');
	if (existsSync(resultsFile)) {
		const r = JSON.parse(readFileSync(resultsFile, 'utf8'));
		const rows = [];
		const walk = (s, prefix) => {
			for (const sp of s.specs ?? []) for (const t of sp.tests) rows.push({ title: sp.title, project: t.projectName, status: t.results.at(-1)?.status ?? t.status });
			for (const c of s.suites ?? []) walk(c, prefix);
		};
		for (const s of r.suites) walk(s, '');
		const md = ['| Check | Project | Result |', '|---|---|---|', ...rows.map((x) => `| ${x.title} | ${x.project} | ${x.status === 'passed' ? 'PASS' : x.status === 'skipped' ? 'SKIP' : 'FAIL'} |`)];
		writeFileSync(join(OUT, 'results.md'), md.join('\n') + '\n');
		const pass = rows.filter((x) => x.status === 'passed').length;
		console.log(`\n[e2e] ${pass} / ${rows.length} passed · table: ${join(OUT, 'results.md')}`);
	}
	process.exitCode = code ?? 1;
} finally {
	stopAll();
	try {
		for (const d of readdirSync(join(OUT, 'legacy'))) execFileSync('git', ['worktree', 'remove', '--force', join(OUT, 'legacy', d)], { cwd: REPO, stdio: 'ignore' });
	} catch {}
	if (!process.env.E2E_KEEP) rmSync(join(OUT, 'pgdata'), { recursive: true, force: true });
}
