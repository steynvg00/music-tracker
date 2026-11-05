#!/usr/bin/env node
/**
 * R1 smoke 7, automated: after `vite build`, the browser bundle must contain no server
 * secret names or values. Run: npm run build && npm run check:client-secrets
 * With the real env loaded (e.g. `vercel env pull`), it also greps for the VALUES.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: the latter keeps %20 and breaks on paths with spaces.
const root = fileURLToPath(new URL('../.svelte-kit/output/client/', import.meta.url));
const names = ['SPOTIFY_CLIENT_SECRET', 'SPOTIFY_CRON_CLIENT_SECRET', 'TOKEN_ENC_KEY', 'SESSION_SECRET', 'DATABASE_URL', 'GITHUB_DISPATCH_TOKEN', 'VAPID_PRIVATE_KEY', 'YOUTUBE_API_KEY', 'refresh_token_enc'];
const values = names.map((n) => process.env[n]).filter((v) => v && v.length >= 8);

const hits = [];
const walk = (dir) => {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.(js|css|html|json|webmanifest)$/.test(f)) {
			const text = readFileSync(p, 'utf8');
			for (const n of names) if (text.includes(n)) hits.push(`${p}: name ${n}`);
			for (const v of values) if (text.includes(v)) hits.push(`${p}: a secret VALUE`);
		}
	}
};
walk(root);
if (hits.length) {
	console.error('Server secrets found in the client bundle:\n' + hits.join('\n'));
	process.exit(1);
}
console.log(`OK: no server secret names${values.length ? ' or values' : ''} in ${root}`);
