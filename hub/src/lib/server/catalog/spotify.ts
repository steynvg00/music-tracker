/**
 * Spotify catalog reads for the Artist pages (beta) and catalog search (v0.90). Read-only GETs on
 * the hub client: GET /artists/{id}, /artists/{id}/albums, /albums/{id}, /albums/{id}/tracks, /search.
 *
 * Politeness, because quota is shared with the crons per developer account (01-feasibility §0.1):
 *   - at most CONCURRENCY requests in flight per server instance (a small semaphore);
 *   - a 429 pauses EVERY catalog request of this instance for Retry-After seconds, then the request
 *     is retried (up to MAX_RETRIES) when Retry-After ≤ MAX_WAIT_S; a longer wait is not sat out in a
 *     serverless function: the 429 goes back to the page, which shows it and retries later;
 *   - pages are fetched only as far as `total` says (first page first, the rest in parallel under the
 *     semaphore), and the album page size falls back to 10 if Spotify ever refuses a bigger limit.
 */
import { SpotifyError, type SpotifyApi } from '$lib/server/spotify/api';
import {
	RELEASE_GROUPS,
	SEARCH_PAGE,
	toRelease,
	type Release,
	type ReleaseGroup,
	type SearchType,
	type SpAlbum,
	type SpImage,
	type SpTrack
} from '$lib/shared/catalog';

export const CONCURRENCY = 4;
export const MAX_RETRIES = 2;
export const MAX_WAIT_S = 3;
/** Same market as the Release radar (R7). */
export const MARKET = 'NL';

export interface CatalogCounters {
	calls: number;
	rateLimited: number;
}

export class Limiter {
	#active = 0;
	#queue: (() => void)[] = [];
	#pausedUntil = 0;
	maxSeen = 0;
	constructor(
		readonly max: number,
		private readonly now: () => number = Date.now,
		private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
	) {}

	pause(ms: number): void {
		this.#pausedUntil = Math.max(this.#pausedUntil, this.now() + ms);
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#active >= this.max) await new Promise<void>((r) => this.#queue.push(r));
		this.#active++;
		this.maxSeen = Math.max(this.maxSeen, this.#active);
		try {
			const wait = this.#pausedUntil - this.now();
			if (wait > 0) await this.sleep(wait);
			return await fn();
		} finally {
			this.#active--;
			this.#queue.shift()?.();
		}
	}
}

/** One limiter per server instance: every catalog request of this lambda shares it. */
export const limiter = new Limiter(CONCURRENCY);

export interface CatalogClientOptions {
	limiter?: Limiter;
	sleep?: (ms: number) => Promise<void>;
	counters?: CatalogCounters;
}

export class CatalogClient {
	readonly counters: CatalogCounters;
	readonly #limiter: Limiter;
	readonly #sleep: (ms: number) => Promise<void>;
	/** Album pages: 50 per request unless Spotify refuses it (then 10, for this instance). */
	static albumPage = 50;

	constructor(
		private readonly api: SpotifyApi,
		opts: CatalogClientOptions = {}
	) {
		this.#limiter = opts.limiter ?? limiter;
		this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.counters = opts.counters ?? { calls: 0, rateLimited: 0 };
	}

	async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				this.counters.calls++;
				const r = await this.#limiter.run(() => this.api.get<T>(path, query));
				if (!r.data) throw new SpotifyError(502, null, `Spotify sent no body for ${path}`);
				return r.data;
			} catch (e) {
				if (!(e instanceof SpotifyError) || e.status !== 429) throw e;
				this.counters.rateLimited++;
				const wait = e.retryAfterS ?? 1;
				this.#limiter.pause(wait * 1000);
				if (attempt >= MAX_RETRIES || wait > MAX_WAIT_S) throw e;
				await this.#sleep(wait * 1000);
			}
		}
	}

	/** Every item of a paged list. `pageSize` falls back to 10 on a 400 (limit refused). */
	async allPages<T>(path: string, query: Record<string, string | number | undefined>, pageSize: number, onPageSize?: (n: number) => void): Promise<T[]> {
		let size = pageSize;
		let first: { items: T[]; total: number };
		try {
			first = await this.get<{ items: T[]; total: number }>(path, { ...query, limit: size, offset: 0 });
		} catch (e) {
			if (!(e instanceof SpotifyError) || e.status !== 400 || size <= 10) throw e;
			size = 10;
			onPageSize?.(size);
			first = await this.get<{ items: T[]; total: number }>(path, { ...query, limit: size, offset: 0 });
		}
		const offsets: number[] = [];
		for (let o = size; o < (first.total ?? 0); o += size) offsets.push(o);
		const rest = await Promise.all(offsets.map((offset) => this.get<{ items: T[] }>(path, { ...query, limit: size, offset })));
		return [first.items ?? [], ...rest.map((p) => p.items ?? [])].flat();
	}

	artist(id: string): Promise<{ id: string; name: string; images?: SpImage[] }> {
		return this.get(`/artists/${id}`);
	}

	/** One include_groups value per request, so every release knows its group. */
	async releases(id: string, group: ReleaseGroup): Promise<Release[]> {
		const items = await this.allPages<SpAlbum>(`/artists/${id}/albums`, { include_groups: group, market: MARKET }, CatalogClient.albumPage, (n) => (CatalogClient.albumPage = n));
		const seen = new Set<string>();
		return items.filter((a) => a?.id && !seen.has(a.id) && seen.add(a.id)).map((a) => toRelease(a, group));
	}

	async discography(id: string): Promise<{ artist: { id: string; name: string; images?: SpImage[] }; releases: Release[] }> {
		const [artist, ...groups] = await Promise.all([this.artist(id), ...RELEASE_GROUPS.map((g) => this.releases(id, g))]);
		// An album in two groups (rare) is shown once, in the first (own releases before appears_on).
		const seen = new Set<string>();
		const releases = groups.flat().filter((r) => !seen.has(r.id) && seen.add(r.id));
		return { artist, releases };
	}

	albumTracks(albumId: string): Promise<SpTrack[]> {
		return this.allPages<SpTrack>(`/albums/${albumId}/tracks`, { market: MARKET }, 50);
	}

	/** Album object + every track (the embedded first page, then /tracks for the rest). */
	async album(id: string): Promise<{ album: SpAlbum; tracks: SpTrack[] }> {
		const a = await this.get<SpAlbum & { tracks?: { items: SpTrack[]; total: number } }>(`/albums/${id}`, { market: MARKET });
		const first = a.tracks?.items ?? [];
		const total = a.tracks?.total ?? first.length;
		const offsets: number[] = [];
		for (let o = first.length; o < total; o += 50) offsets.push(o);
		const rest = await Promise.all(offsets.map((offset) => this.get<{ items: SpTrack[] }>(`/albums/${id}/tracks`, { market: MARKET, limit: 50, offset })));
		return { album: a, tracks: [...first, ...rest.flatMap((p) => p.items ?? [])] };
	}

	/** Spotify search, at most 10 per type per request (Feb 2026). */
	search(q: string, types: SearchType[], offset: number): Promise<Record<string, { items: unknown[]; total: number; offset: number } | undefined>> {
		return this.get('/search', { q, type: types.join(','), limit: SEARCH_PAGE, offset, market: MARKET });
	}
}
