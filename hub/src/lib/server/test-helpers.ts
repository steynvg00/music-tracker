/** Test-only fakes for Spotify (fetch) and Postgres (tagged-template sql). Not imported by app code. */
import type { Sql } from '$lib/server/db';

export interface RecordedRequest {
	method: string;
	url: URL;
	body: unknown;
	headers: Record<string, string>;
}

export type Route = (req: RecordedRequest) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** A fetch that answers from `route` and records every call. Unmatched calls → 500. */
export function fakeFetch(route: Route) {
	const calls: RecordedRequest[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
		const raw = init?.body;
		let body: unknown = raw;
		if (typeof raw === 'string') {
			try {
				body = JSON.parse(raw);
			} catch {
				body = Object.fromEntries(new URLSearchParams(raw));
			}
		}
		const req: RecordedRequest = {
			method: (init?.method ?? 'GET').toUpperCase(),
			url,
			body,
			headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}))
		};
		calls.push(req);
		const r = route(req) ?? { status: 500, body: { error: 'unrouted' } };
		const text = r.body === undefined ? '' : JSON.stringify(r.body);
		return new Response(r.status === 204 ? null : text, { status: r.status, headers: r.headers });
	}) as typeof fetch;
	return { fetch: f, calls };
}

export interface FakeQuery {
	text: string;
	values: unknown[];
}

/** Tagged-template SQL fake. `handler` returns rows for each query. `begin` runs the callback inline. */
export function fakeSql(handler: (q: FakeQuery) => unknown[] | undefined) {
	const queries: FakeQuery[] = [];
	const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		const q = { text: strings.join('$').replace(/\s+/g, ' ').trim(), values };
		queries.push(q);
		const rows = handler(q) ?? [];
		return Promise.resolve(Object.assign([...rows], { count: rows.length }));
	}) as unknown as Sql & { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> };
	(fn as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (cb) => cb(fn);
	return { sql: fn as Sql, queries };
}
