/**
 * Service-worker cache policy (src/service-worker.ts), kept free of `$service-worker` and
 * worker globals so it can be unit-tested (cache-policy.test.ts).
 *
 * Why it looks like this: after R1's broken first deploys an iPhone kept serving an old
 * app shell and hung on load until website data was cleared. Old HTML lived in an
 * unversioned cache and outlived the hashed chunks it referenced. The rules now:
 *
 *   1. Every cache name carries the build version. Activate deletes every other `rotor-*`
 *      cache (including pre-v0.82 names), so cached HTML always matches cached chunks.
 *   2. Only 2xx, same-origin, non-redirected responses are stored. Pages additionally
 *      must be text/html and not `Cache-Control: no-store`. Error pages (4xx/5xx) and
 *      failed navigations are passed through to the browser but never cached.
 *   3. Navigations are network-first. The cached copy is used only when the network
 *      request itself fails (offline): never because the server answered with an error.
 */

export const CACHE_PREFIX = 'rotor-';
export const OFFLINE_PATH = '/offline';

export interface CacheNames {
	/** build + static files, precached on install, cache-first */
	shell: string;
	/** HTML of a few pages, offline fallback only */
	pages: string;
	/** last /api/home payload (stale-while-revalidate) */
	data: string;
}

export function cacheNames(version: string): CacheNames {
	return {
		shell: `${CACHE_PREFIX}shell-${version}`,
		pages: `${CACHE_PREFIX}pages-${version}`,
		data: `${CACHE_PREFIX}data-${version}`
	};
}

/** Caches to delete on activate: every Rotor cache that isn't this build's. */
export function staleCaches(keys: readonly string[], version: string): string[] {
	const keep = new Set(Object.values(cacheNames(version)));
	return keys.filter((k) => k.startsWith(CACHE_PREFIX) && !keep.has(k));
}

/** 2xx (not 206), not redirected, same-origin. `default` is a constructed Response (tests). */
export function isCacheableResponse(res: Response): boolean {
	return (
		res.ok &&
		res.status !== 206 &&
		!res.redirected &&
		(res.type === 'basic' || res.type === 'default') &&
		!/\bno-store\b/i.test(res.headers.get('Cache-Control') ?? '')
	);
}

/** A navigation response worth keeping as an offline fallback. */
export function isCacheablePage(res: Response): boolean {
	return isCacheableResponse(res) && (res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html');
}

/** Pages whose HTML is kept for offline use (start_url is /home). */
export function isOfflinePage(pathname: string): boolean {
	return /^\/(home|daily|settings)?\/?$|^\/daily\/[^/]+\/?$/.test(pathname) || pathname === OFFLINE_PATH;
}

/** The subset of the Cache API the handlers use (lets tests pass a Map-backed fake). */
export interface CacheLike {
	match(request: RequestInfo | URL): Promise<Response | undefined>;
	put(request: RequestInfo | URL, response: Response): Promise<void>;
}

export type FetchLike = (request: Request) => Promise<Response>;

const OFFLINE_HTML =
	'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rotor</title>' +
	'<p style="font-family:system-ui;color:#f5f5f7;background:#0b0b0e;margin:0;min-height:100dvh;display:grid;place-items:center">You’re offline.</p>';

export function offlineResponse(): Response {
	return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function safePut(cache: CacheLike, request: Request, res: Response): Promise<void> {
	try {
		await cache.put(request, res);
	} catch {
		// Quota or a body that can't be stored: serving the response matters more.
	}
}

/**
 * Network-first navigation. Whatever the server answers (including 4xx/5xx) is returned
 * as-is; only good HTML of an offline page is stored. The cache is read only when fetch()
 * throws, i.e. there is no network: this page's copy, then /home for "/", then /offline.
 */
export async function networkFirstPage(request: Request, deps: { fetch: FetchLike; cache: CacheLike }): Promise<Response> {
	const path = new URL(request.url).pathname;
	// Call fetch unbound: `deps.fetch(request)` would run the worker's fetch with `this = deps`,
	// which browsers reject ("Illegal invocation"), so every navigation fell back to offline.
	const fetchFn = deps.fetch;
	let res: Response;
	try {
		res = await fetchFn(request);
	} catch (e) {
		console.warn('[rotor-sw] network failed for', path, '→ offline fallback:', e instanceof Error ? e.message : e);
		return (
			(await deps.cache.match(request)) ??
			(path === '/' ? await deps.cache.match('/home') : undefined) ??
			(await deps.cache.match(OFFLINE_PATH)) ??
			offlineResponse()
		);
	}
	if (isOfflinePage(path) && isCacheablePage(res)) await safePut(deps.cache, request, res.clone());
	return res;
}

const offlineJson = () =>
	new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * Stale-while-revalidate for /api/home. A cached copy is marked X-Rotor-Stale: 1; error
 * responses replace nothing. `cache: 'no-store'` requests (pull-to-refresh) skip the cache.
 */
export async function staleWhileRevalidate(
	request: Request,
	deps: { fetch: FetchLike; cache: CacheLike; waitUntil: (p: Promise<unknown>) => void }
): Promise<Response> {
	const fetchFn = deps.fetch; // unbound, see networkFirstPage
	const network = fetchFn(request)
		.then(async (res) => {
			if (isCacheableResponse(res)) await safePut(deps.cache, request, res.clone());
			return res;
		})
		.catch(() => null);
	if (request.cache === 'no-store') return (await network) ?? offlineJson();
	const cached = await deps.cache.match(request);
	if (cached) {
		deps.waitUntil(network);
		const headers = new Headers(cached.headers);
		headers.set('X-Rotor-Stale', '1');
		return new Response(cached.body, { status: cached.status, headers });
	}
	return (await network) ?? offlineJson();
}
