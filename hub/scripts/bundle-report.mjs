#!/usr/bin/env node
/**
 * v0.92: JS per route after `vite build`. For each page: the gzipped JS a cold load of that route
 * downloads (SvelteKit's entry + the root and (app) layouts + the page, static imports, deduped),
 * and the page's own share. Run: npm run build && node scripts/bundle-report.mjs [--json out.json]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = fileURLToPath(new URL('..', import.meta.url));
const CLIENT = join(HUB, '.svelte-kit/output/client');
const manifest = JSON.parse(readFileSync(join(CLIENT, '.vite/manifest.json'), 'utf8'));
const NODES = join(HUB, '.svelte-kit/generated/client-optimized/nodes');
const gz = new Map();
const size = (file) => {
	if (!gz.has(file)) gz.set(file, gzipSync(readFileSync(join(CLIENT, file))).length);
	return gz.get(file);
};
function closure(key, seen = new Set()) {
	const m = manifest[key];
	if (!m || seen.has(m.file)) return seen;
	seen.add(m.file);
	for (const i of m.imports ?? []) closure(i, seen);
	return seen;
}
const nodeKey = (n) => `.svelte-kit/generated/client-optimized/nodes/${n}`;
const routeOf = new Map();
for (const f of readdirSync(NODES)) {
	const src = readFileSync(join(NODES, f), 'utf8');
	const m = /src\/routes\/(.*?)\/?\+(page|layout|error)\.svelte/.exec(src);
	routeOf.set(f, m ? `${m[2]}:/${m[1]}` : 'other');
}
const entryKeys = Object.keys(manifest).filter((k) => manifest[k].isEntry && !k.includes('/nodes/'));
const base = new Set();
for (const k of entryKeys) closure(k, base);
const layoutRoot = [...routeOf].find(([, r]) => r === 'layout:/')?.[0];
const layoutApp = [...routeOf].find(([, r]) => r === 'layout:/(app)')?.[0];
const shared = new Set(base);
for (const l of [layoutRoot, layoutApp]) if (l) closure(nodeKey(l), shared);
const sum = (set) => [...set].reduce((n, f) => n + size(f), 0);
const rows = [];
for (const [f, r] of routeOf) {
	if (!r.startsWith('page:')) continue;
	const page = closure(nodeKey(f));
	const own = new Set([...page].filter((x) => !shared.has(x)));
	const total = new Set([...shared, ...page]);
	rows.push({ route: r.slice(5).replace(/^\/\(app\)/, '') || '/', totalKb: Math.round(sum(total) / 102.4) / 10, pageKb: Math.round(sum(own) / 102.4) / 10 });
}
rows.sort((a, b) => a.route.localeCompare(b.route));
const out = { sharedKb: Math.round(sum(shared) / 102.4) / 10, routes: rows };
const jsonAt = process.argv.indexOf('--json');
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2));
console.log(`shared (entry + layouts): ${out.sharedKb} kB gzip`);
console.log('| Route | Cold JS (gzip) | Page only |\n|---|---|---|');
for (const r of rows) console.log(`| ${r.route} | ${r.totalKb} kB | ${r.pageKb} kB |`);
if (!existsSync(CLIENT)) process.exit(1);
