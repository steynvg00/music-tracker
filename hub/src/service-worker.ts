/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * App shell + last Home payload (04-architecture.md §6.3).
 *   build/static assets  cache-first, versioned per deploy
 *   GET /api/home        stale-while-revalidate (cached copy marked X-Rotor-Stale: 1)
 *   pages                network-first, cached copy when offline
 *   everything else      network only: player state, tokens and OAuth are never cached
 */
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const SHELL = `rotor-shell-${version}`;
const DATA = 'rotor-data';
const ASSETS = new Set([...build, ...files]);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(SHELL)
			.then((c) => c.addAll([...ASSETS]))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith('rotor-shell-') && k !== SHELL).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('message', (event) => {
	if (event.data?.type === 'clear-data') event.waitUntil(caches.delete(DATA));
});

function cacheable(res: Response): boolean {
	return res.ok && !res.redirected && res.type === 'basic';
}

async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
	const cache = await caches.open(DATA);
	const network = fetch(event.request)
		.then(async (res) => {
			if (cacheable(res)) await cache.put(event.request, res.clone());
			return res;
		})
		.catch(() => null);
	if (event.request.cache === 'no-store') {
		const res = await network;
		return res ?? new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
	}
	const cached = await cache.match(event.request);
	if (cached) {
		event.waitUntil(network);
		const headers = new Headers(cached.headers);
		headers.set('X-Rotor-Stale', '1');
		return new Response(cached.body, { status: cached.status, headers });
	}
	return (await network) ?? new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}

async function networkFirstPage(request: Request): Promise<Response> {
	const cache = await caches.open(DATA);
	try {
		const res = await fetch(request);
		if (cacheable(res) && /^\/(home|daily|settings)?\/?$|^\/daily\//.test(new URL(request.url).pathname)) {
			await cache.put(request, res.clone());
		}
		return res;
	} catch {
		return (
			(await cache.match(request)) ??
			(await cache.match('/home')) ??
			new Response('<!doctype html><title>Rotor</title><p style="font-family:system-ui;color:#f5f5f7;background:#0b0b0e">You’re offline.</p>', {
				headers: { 'Content-Type': 'text/html; charset=utf-8' }
			})
		);
	}
}

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	if (ASSETS.has(url.pathname)) {
		event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
		return;
	}
	if (url.pathname === '/api/home') {
		event.respondWith(staleWhileRevalidate(event));
		return;
	}
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
	if (request.mode === 'navigate') event.respondWith(networkFirstPage(request));
});
