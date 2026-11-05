/**
 * HTTP glue for the stats APIs (R3): `Cache-Control: private, max-age=30` + an ETag derived
 * from the last rollup refresh (04-architecture.md §6.3). New plays only arrive through the
 * ingest, which refreshes the rollups, so the refresh time changes whenever the data does.
 */
import { json } from '@sveltejs/kit';
import type { Queryable } from '$lib/server/db';
import { apiError, toResponse } from '$lib/server/http';

/** Postgres codes meaning "migration 0023 isn't applied yet". */
const MISSING = new Set(['42P01', '42883', '3F000']);

export function isRollupsMissing(e: unknown): boolean {
	return !!e && typeof e === 'object' && MISSING.has(String((e as { code?: unknown }).code));
}

export function rollupsMissing(): Response {
	return apiError(503, { error: 'rollups_missing', message: 'Stats need migration 0023_hub_stats_rollups.sql' });
}

/** FNV-1a, enough to key an ETag on the request. */
export function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

export async function refreshedAt(sql: Queryable): Promise<string | null> {
	const [r] = await sql<{ refreshed_at: Date | null }[]>`SELECT refreshed_at FROM hub.rollup_state`;
	return r?.refreshed_at ? new Date(r.refreshed_at).toISOString() : null;
}

/**
 * Answer a stats GET: 304 when the client's ETag still matches, else compute + 200.
 * `key` must include everything the body depends on besides the data (query, today).
 */
export async function statsResponse(sql: Queryable, request: Request, key: string, compute: () => Promise<unknown>): Promise<Response> {
	try {
		const at = await refreshedAt(sql);
		const etag = `W/"${hash(`${at}|${key}`)}"`;
		const headers = { 'Cache-Control': 'private, max-age=30', ETag: etag };
		if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
		const body = await compute();
		if (body === null) return apiError(404, { error: 'not_found', message: 'Not in your history' });
		return json(body, { headers });
	} catch (e) {
		if (isRollupsMissing(e)) return rollupsMissing();
		return toResponse(e);
	}
}
