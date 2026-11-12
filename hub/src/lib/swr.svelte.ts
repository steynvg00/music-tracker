/**
 * v0.92: client stale-while-revalidate cache for GET API data (memory + IndexedDB).
 *
 *   - A page load gets its data INSTANTLY from memory (this session) or IndexedDB (PWA reopened), and
 *     the network answer replaces it in place when it arrives: the returned object is reactive ($state),
 *     so the page updates without re-running its load. No cache entry → a normal network load.
 *   - Keyed per BUILD (`version` from $app/environment): a deploy never serves an older shape; older
 *     builds' IndexedDB databases are deleted on start.
 *   - Only 2xx JSON is stored, never an error (the R2/#93/#94 rule for the service worker, here too).
 *   - Any successful write (POST/PUT/PATCH/DELETE through the api client) marks every entry stale:
 *     still shown at once, but always refreshed before being trusted again.
 *   - Server-side rendering never uses it (no window): SSR is always fresh.
 */
import { browser, version } from '$app/environment';

export interface Loaded<T> {
	data: T | null;
	status: number;
	message: string | null;
	/** true while the shown data came from the cache and the network answer hasn't arrived yet */
	stale?: boolean;
}

interface Entry {
	json: string;
	at: number;
}

const DB_PREFIX = 'rotor-swr-';
const DB = `${DB_PREFIX}${version}`;
const STORE = 'api';
const MAX_AGE_MS = 7 * 86_400_000;
const mem = new Map<string, Entry>();
const live = new Map<string, Loaded<unknown>>();
let epoch = 0; // bumped by writes: entries older than this are stale
let dbp: Promise<IDBDatabase | null> | null = null;

function idb(): Promise<IDBDatabase | null> {
	if (!browser || typeof indexedDB === 'undefined') return Promise.resolve(null);
	return (dbp ??= new Promise((ok) => {
		try {
			const req = indexedDB.open(DB, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(STORE);
			req.onsuccess = () => ok(req.result);
			req.onerror = () => ok(null);
			req.onblocked = () => ok(null);
			// Older builds' caches: their shapes may differ, never read them.
			void indexedDB.databases?.().then((dbs) => {
				for (const d of dbs) if (d.name?.startsWith(DB_PREFIX) && d.name !== DB) indexedDB.deleteDatabase(d.name);
			});
		} catch {
			ok(null);
		}
	}));
}

async function idbGet(key: string): Promise<Entry | null> {
	const db = await idb();
	if (!db) return null;
	return new Promise((ok) => {
		try {
			const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
			r.onsuccess = () => ok((r.result as Entry | undefined) ?? null);
			r.onerror = () => ok(null);
		} catch {
			ok(null);
		}
	});
}

async function idbPut(key: string, e: Entry): Promise<void> {
	const db = await idb();
	if (!db) return;
	try {
		db.transaction(STORE, 'readwrite').objectStore(STORE).put(e, key);
	} catch {
		/* quota / private mode: memory still works */
	}
}

/**
 * Until the app has hydrated, never answer from the cache: SvelteKit re-runs universal loads in the
 * browser during hydration and answers their fetches from the server's response inlined in the page,
 * which is fresh and free. A cached copy there could be older than the page itself (e.g. after a
 * reload that follows a write in another tab).
 */
let hydrated = false;
export function swrHydrated(): void {
	hydrated = true;
}

/** Mark every cached answer stale (after a write). Called by the api client. */
export function swrInvalidate(): void {
	epoch = Date.now();
}

/** For tests: forget everything (memory + this build's IndexedDB). */
export async function swrClear(): Promise<void> {
	mem.clear();
	live.clear();
	const db = await idb();
	try {
		db?.transaction(STORE, 'readwrite').objectStore(STORE).clear();
	} catch {
		/* ignore */
	}
}

async function network<T>(f: typeof fetch, path: string): Promise<{ loaded: Loaded<T>; json: string | null }> {
	try {
		const res = await f(path, { headers: { Accept: 'application/json', 'X-Rotor-Fresh': '1' } });
		if (res.ok) {
			const json = await res.text();
			return { loaded: { data: JSON.parse(json) as T, status: res.status, message: null }, json };
		}
		const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
		return { loaded: { data: null, status: res.status, message: body.message ?? body.error ?? `HTTP ${res.status}` }, json: null };
	} catch {
		return { loaded: { data: null, status: 0, message: 'Rotor is offline' }, json: null };
	}
}

const inflight = new Map<string, Promise<void>>();

/**
 * GET `path` as JSON through the cache. On the server: a plain fetch. In the browser: cached data at
 * once (with a background refresh), else the network.
 */
export async function swrLoad<T>(f: typeof fetch, path: string): Promise<Loaded<T>> {
	if (!browser) return (await network<T>(f, path)).loaded;
	if (!hydrated) {
		const { loaded, json } = await network<T>(f, path);
		if (json) store(path, json);
		return remember(path, loaded);
	}
	const hit = mem.get(path) ?? (await idbGet(path));
	// No entry, too old, or older than your last write (e.g. a playlist you just changed): network first.
	if (!hit || Date.now() - hit.at > MAX_AGE_MS || hit.at < epoch) {
		const { loaded, json } = await network<T>(f, path);
		if (json) store(path, json);
		return remember(path, loaded);
	}
	const r = remember<T>(path, { data: JSON.parse(hit.json) as T, status: 200, message: null, stale: true });
	revalidate<T>(path, hit, r);
	return r;
}

function remember<T>(path: string, l: Loaded<T>): Loaded<T> {
	const r = $state(l);
	live.set(path, r as Loaded<unknown>);
	return r;
}

function store(path: string, json: string): void {
	const e = { json, at: Date.now() };
	mem.set(path, e);
	void idbPut(path, e);
}

function revalidate<T>(path: string, hit: Entry, r: Loaded<T>): void {
	if (inflight.has(path)) return;
	const p = (async () => {
		// The global fetch, not the load's: the load has already returned.
		const { loaded, json } = await network<T>(fetch, path);
		if (json) {
			store(path, json);
			if (json !== hit.json) r.data = loaded.data;
			r.stale = false;
		} else if (loaded.status !== 0) {
			// The server now refuses (e.g. 401/404/503): show that, never keep serving the old answer.
			mem.delete(path);
			r.data = null;
			r.status = loaded.status;
			r.message = loaded.message;
			r.stale = false;
		} else {
			r.stale = false; // offline: keep showing the cached data
		}
	})().finally(() => inflight.delete(path));
	inflight.set(path, p);
}

/** Warm the cache in the background (next likely tab). Never throws. */
export function swrPrefetch(paths: string[]): void {
	if (!browser) return;
	for (const p of paths) {
		if (mem.has(p) || inflight.has(p)) continue;
		const job = network(fetch, p)
			.then(({ json }) => json && store(p, json))
			.catch(() => undefined)
			.finally(() => inflight.delete(p));
		inflight.set(p, job as Promise<void>);
	}
}
