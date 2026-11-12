/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * App shell + last Home payload (04-architecture.md §6.3). Policy and its tests live in
 * $lib/sw/cache-policy.ts; the short version:
 *   build/static assets  precached per build (bypassing the HTTP cache), cache-first
 *   pages (navigations)  network-first; the cached copy only when the network is down
 *   GET /api/home        stale-while-revalidate (cached copy marked X-Rotor-Stale: 1)
 *   everything else      network only: player state, tokens and OAuth are never cached
 * Every cache is named after the build version and activate deletes all other `rotor-*`
 * caches, so a new deploy can't leave an old shell (or old HTML) behind. Error responses
 * are never stored.
 */
import { build, files, version } from '$service-worker';
import { OFFLINE_PATH, cacheNames, isCacheablePage, networkFirstPage, staleCaches, staleWhileRevalidate } from '$lib/sw/cache-policy';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHES = cacheNames(version);
const ASSETS = new Set([...build, ...files]);

async function precache(): Promise<void> {
	const shell = await caches.open(CACHES.shell);
	// cache: 'reload' so a stale HTTP-cached copy of a static file can't end up in the shell.
	await shell.addAll([...ASSETS].map((u) => new Request(u, { cache: 'reload' })));
	try {
		// Best effort: the offline page, from THIS build, as the last-resort fallback.
		const res = await fetch(new Request(OFFLINE_PATH, { cache: 'reload', credentials: 'same-origin' }));
		if (isCacheablePage(res)) await (await caches.open(CACHES.pages)).put(OFFLINE_PATH, res);
	} catch {
		// Offline during install: the inline fallback in cache-policy.ts covers it.
	}
}

sw.addEventListener('install', (event) => {
	event.waitUntil(precache().then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(staleCaches(keys, version).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('message', (event) => {
	// Settings › Clear caches: cached pages + Home payload (the shell stays; it's this build's).
	if (event.data?.type === 'clear-data') event.waitUntil(Promise.all([caches.delete(CACHES.data), caches.delete(CACHES.pages)]));
});

// ── Web Push (R2): daily pick ready, token expiring, job finished ───────────
interface PushPayload {
	title?: string;
	body?: string;
	url?: string;
	tag?: string;
}

sw.addEventListener('push', (event) => {
	let d: PushPayload = {};
	try {
		d = (event.data?.json() as PushPayload) ?? {};
	} catch {
		d = { body: event.data?.text() };
	}
	event.waitUntil(
		sw.registration.showNotification(d.title || 'Rotor', {
			body: d.body ?? '',
			tag: d.tag,
			icon: '/icons/icon-192.png',
			badge: '/icons/icon-192.png',
			data: { url: typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : '/home' }
		})
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = new URL((event.notification.data as { url?: string } | null)?.url ?? '/home', sw.location.origin).href;
	event.waitUntil(
		sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
			for (const c of list) {
				if ('focus' in c) {
					await (c as WindowClient).navigate(url).catch(() => undefined);
					return (c as WindowClient).focus();
				}
			}
			return sw.clients.openWindow(url);
		})
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	if (ASSETS.has(url.pathname)) {
		event.respondWith(
			caches
				.open(CACHES.shell)
				.then((c) => c.match(request))
				.then((hit) => hit ?? fetch(request))
		);
		return;
	}
	// v0.92: the app's own cache (lib/swr.svelte.ts) asks for the network answer with X-Rotor-Fresh.
	if (url.pathname === '/api/home' && request.headers.get('x-rotor-fresh') !== '1') {
		event.respondWith(
			caches.open(CACHES.data).then((cache) => staleWhileRevalidate(request, { fetch, cache, waitUntil: (p) => event.waitUntil(p) }))
		);
		return;
	}
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
	if (request.mode === 'navigate') {
		event.respondWith(caches.open(CACHES.pages).then((cache) => networkFirstPage(request, { fetch, cache })));
	}
});
