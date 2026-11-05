import { describe, expect, it } from 'vitest';
import {
	cacheNames,
	isCacheablePage,
	isCacheableResponse,
	networkFirstPage,
	staleCaches,
	staleWhileRevalidate,
	type CacheLike
} from './cache-policy';

const ORIGIN = 'https://rotor.example';

/** Map-backed Cache API fake, keyed by pathname. */
function fakeCache(seed: Record<string, Response> = {}) {
	const store = new Map<string, Response>(Object.entries(seed));
	const key = (r: RequestInfo | URL) => new URL(typeof r === 'string' ? r : r instanceof URL ? r.href : r.url, ORIGIN).pathname;
	const cache: CacheLike = {
		async match(r) {
			return store.get(key(r))?.clone();
		},
		async put(r, res) {
			store.set(key(r), res);
		}
	};
	return { cache, store };
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
	new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const nav = (path: string) => new Request(ORIGIN + path, { headers: { Accept: 'text/html' } });

describe('error responses are never cached', () => {
	it.each([400, 401, 403, 404, 500, 502, 503, 504])('a %i navigation is returned but not stored', async (status) => {
		const { cache, store } = fakeCache();
		const res = await networkFirstPage(nav('/home'), { fetch: async () => html('<h1>broken deploy</h1>', status), cache });
		expect(res.status).toBe(status); // the browser sees the real answer…
		expect(store.size).toBe(0); // …but it never becomes the offline shell
	});

	it('an error never replaces a good cached page', async () => {
		const { cache, store } = fakeCache({ '/home': html('good shell') });
		await networkFirstPage(nav('/home'), { fetch: async () => html('oops', 500), cache });
		expect(await store.get('/home')!.clone().text()).toBe('good shell');
	});

	it('a failed /api/home refresh keeps the last good payload', async () => {
		const { cache, store } = fakeCache();
		const req = new Request(ORIGIN + '/api/home', { cache: 'no-store' });
		const res = await staleWhileRevalidate(req, {
			fetch: async () => new Response('{"error":"x"}', { status: 500 }),
			cache,
			waitUntil: () => undefined
		});
		expect(res.status).toBe(500);
		expect(store.size).toBe(0);
	});

	it('isCacheableResponse rejects non-2xx, partial, redirected, opaque and no-store', () => {
		expect(isCacheableResponse(new Response('x', { status: 200 }))).toBe(true);
		expect(isCacheableResponse(new Response('x', { status: 404 }))).toBe(false);
		expect(isCacheableResponse(new Response('x', { status: 500 }))).toBe(false);
		expect(isCacheableResponse(new Response('x', { status: 206 }))).toBe(false);
		expect(isCacheableResponse(new Response('x', { status: 200, headers: { 'Cache-Control': 'no-store' } }))).toBe(false);
		const redirected = new Response('x');
		Object.defineProperty(redirected, 'redirected', { value: true });
		expect(isCacheableResponse(redirected)).toBe(false);
		const opaque = new Response('x');
		Object.defineProperty(opaque, 'type', { value: 'opaque' });
		expect(isCacheableResponse(opaque)).toBe(false);
	});

	it('a 200 that is not HTML is not stored as a page', () => {
		expect(isCacheablePage(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toBe(false);
		expect(isCacheablePage(html('<p>ok</p>'))).toBe(true);
	});
});

describe('navigations are network-first', () => {
	it('stores good HTML of an offline page and returns the network copy', async () => {
		const { cache, store } = fakeCache({ '/home': html('old build') });
		const res = await networkFirstPage(nav('/home'), { fetch: async () => html('new build'), cache });
		expect(await res.text()).toBe('new build');
		expect(await store.get('/home')!.clone().text()).toBe('new build');
	});

	it('does not store pages outside the offline set', async () => {
		const { cache, store } = fakeCache();
		await networkFirstPage(nav('/library'), { fetch: async () => html('lib'), cache });
		expect(store.size).toBe(0);
	});

	it('uses the cache only when the network is down: page, then /home for /, then /offline, then inline', async () => {
		const down = async () => {
			throw new TypeError('Failed to fetch');
		};
		const both = fakeCache({ '/settings': html('cached settings'), '/home': html('cached home'), '/offline': html('offline page') });
		expect(await (await networkFirstPage(nav('/settings'), { fetch: down, cache: both.cache })).text()).toBe('cached settings');
		expect(await (await networkFirstPage(nav('/'), { fetch: down, cache: both.cache })).text()).toBe('cached home');
		expect(await (await networkFirstPage(nav('/library'), { fetch: down, cache: both.cache })).text()).toBe('offline page');
		const empty = fakeCache();
		const inline = await networkFirstPage(nav('/library'), { fetch: down, cache: empty.cache });
		expect(inline.status).toBe(503);
		expect(await inline.text()).toContain('offline');
	});
});

describe('caches are versioned per build', () => {
	it('names every cache after the build version', () => {
		expect(cacheNames('123')).toEqual({ shell: 'rotor-shell-123', pages: 'rotor-pages-123', data: 'rotor-data-123' });
	});

	it('activate deletes every other Rotor cache, incl. the pre-v0.82 unversioned one, and nothing else', () => {
		const keys = ['rotor-shell-old', 'rotor-data', 'rotor-pages-old', 'rotor-data-old', 'rotor-shell-new', 'rotor-pages-new', 'rotor-data-new', 'someone-else'];
		expect(staleCaches(keys, 'new').sort()).toEqual(['rotor-data', 'rotor-data-old', 'rotor-pages-old', 'rotor-shell-old']);
	});
});
