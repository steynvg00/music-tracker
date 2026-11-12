/**
 * v0.92: per-request server timings (DB, Spotify, other external calls), reported as a
 * Server-Timing header (hooks.server.ts) so the browser, the E2E perf run and Vercel logs can see
 * where a response's time went. AsyncLocalStorage keeps the counters per request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Timings {
	start: number;
	db: number;
	dbN: number;
	spotify: number;
	spotifyN: number;
	ext: number;
	extN: number;
}

const store = new AsyncLocalStorage<Timings>();

export function withTimings<T>(fn: () => T): { t: Timings; result: T } {
	const t: Timings = { start: performance.now(), db: 0, dbN: 0, spotify: 0, spotifyN: 0, ext: 0, extN: 0 };
	return { t, result: store.run(t, fn) };
}

export function record(kind: 'db' | 'spotify' | 'ext', ms: number): void {
	const t = store.getStore();
	if (!t) return;
	t[kind] += ms;
	if (kind === 'db') t.dbN++;
	else if (kind === 'spotify') t.spotifyN++;
	else t.extN++;
}

/** Server-Timing value. "db" can exceed wall time when queries run in parallel (sum of durations). */
export function serverTiming(t: Timings): string {
	const r = (n: number) => Math.round(n * 10) / 10;
	const total = performance.now() - t.start;
	const parts = [`db;dur=${r(t.db)};desc="${t.dbN} queries"`, `spotify;dur=${r(t.spotify)};desc="${t.spotifyN} calls"`];
	if (t.extN) parts.push(`ext;dur=${r(t.ext)};desc="${t.extN} calls"`);
	parts.push(`total;dur=${r(total)}`);
	return parts.join(', ');
}

/** Wrap a postgres.js tagged-template function so every awaited query adds its time to "db". */
export function timedSql<S extends object>(sql: S): S {
	return new Proxy(sql, {
		apply(target, thisArg, args) {
			const q = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args) as { then?: unknown } | null;
			if (!q || typeof q !== 'object' || typeof q.then !== 'function' || !Array.isArray(args[0]) || !('raw' in (args[0] as object))) return q;
			const then = (q.then as (a?: unknown, b?: unknown) => Promise<unknown>).bind(q);
			let t0 = 0;
			(q as { then: unknown }).then = (ok?: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
				t0 ||= performance.now();
				return then(
					(v: unknown) => {
						record('db', performance.now() - t0);
						return ok ? ok(v) : v;
					},
					(e: unknown) => {
						record('db', performance.now() - t0);
						if (ko) return ko(e);
						throw e;
					}
				);
			};
			return q;
		}
	});
}
