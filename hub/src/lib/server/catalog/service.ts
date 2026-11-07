/**
 * Artist pages (beta) + catalog search: Spotify (live) + the 0031 cache + your own data.
 */
import type { Queryable } from '$lib/server/db';
import { SpotifyError } from '$lib/server/spotify/api';
import {
	myState,
	ownTracks,
	packOwnTrack,
	unpackOwnTrack,
	pickImage,
	toRelease,
	toTrack,
	SEARCH_TYPES,
	type ArtistPage,
	type CatalogAlbum,
	type CatalogSearchResults,
	type CatalogTrack,
	type ReleaseWithState,
	type SearchType,
	type SpAlbum,
	type SpTrack
} from '$lib/shared/catalog';
import type { CatalogClient } from './spotify';
import { countStats, enforceCap, readAppears, readArtist, touchArtist, writeAppears, writeArtist } from './cache';
import { artistMine, releaseMine, trackMine } from './mine';

/** Appears-on own tracks are fetched for at most this many albums per request (the page asks in batches). */
export const APPEARS_BATCH = 12;

export class NotOpened extends Error {
	constructor() {
		super('Open the artist page first: only artists you open are cached');
		this.name = 'NotOpened';
	}
}

async function withCounters<T>(sql: Queryable, client: CatalogClient, fn: () => Promise<T>, extra: { hits?: number; misses?: number } = {}): Promise<T> {
	const c0 = { ...client.counters };
	try {
		return await fn();
	} finally {
		await countStats(sql, { ...extra, calls: client.counters.calls - c0.calls, rateLimited: client.counters.rateLimited - c0.rateLimited }).catch(() => undefined);
	}
}

export async function artistPage(sql: Queryable, client: CatalogClient, id: string, now: Date = new Date()): Promise<ArtistPage> {
	const cached = await readArtist(sql, id, now);
	let artist = cached?.artist;
	let releases = cached?.releases ?? [];
	let fetchedAt = cached?.fetchedAt ?? now;
	let hit = !!cached?.fresh;
	let stale = false;
	if (cached?.fresh) {
		await touchArtist(sql, id, now);
		await countStats(sql, { hits: 1 });
	} else {
		try {
			const live = await withCounters(sql, client, () => client.discography(id), { misses: 1 });
			artist = { id, name: live.artist.name, image: pickImage(live.artist.images) };
			releases = live.releases;
			fetchedAt = now;
			await writeArtist(sql, artist, releases, now);
			await enforceCap(sql, id);
		} catch (e) {
			// Spotify refused (429 / outage) but an expired copy exists: show it, marked stale.
			if (!cached || !(e instanceof SpotifyError)) throw e;
			stale = true;
			hit = true;
			await touchArtist(sql, id, now);
		}
	}
	const [mine, perRelease] = await Promise.all([artistMine(sql, id), releaseMine(sql, releases.map((r) => r.id))]);
	const withState: ReleaseWithState[] = releases.map((r) => {
		const m = perRelease.get(r.id) ?? { plays: 0, liked: false };
		return { ...r, plays: m.plays, liked: m.liked, state: myState(m.plays, m.liked) };
	});
	return { artist: artist!, mine, releases: withState, cache: { hit, stale, fetchedAt: fetchedAt.toISOString() } };
}

/**
 * The artist's own tracks on "Appears on" releases, for up to APPEARS_BATCH album ids. Cached ones
 * come from 0031; the rest are fetched (album tracks, filtered to this artist) and cached as one batch.
 */
export async function appearsTracks(sql: Queryable, client: CatalogClient, id: string, albumIds: string[], now: Date = new Date()): Promise<Record<string, CatalogTrack[]>> {
	const cached = await readArtist(sql, id, now);
	if (!cached) throw new NotOpened();
	const allowed = new Set(cached.releases.filter((r) => r.group === 'appears_on').map((r) => r.id));
	const wanted = [...new Set(albumIds)].filter((a) => allowed.has(a)).slice(0, APPEARS_BATCH);
	const have = await readAppears(sql, cached.artist);
	const missing = wanted.filter((a) => !have.has(a));
	const fetched = new Map<string, CatalogTrack[]>();
	if (missing.length) {
		await withCounters(sql, client, async () => {
			const lists = await Promise.all(missing.map((a) => client.albumTracks(a)));
			// Exactly what the cache keeps (and returns on the next visit): id, name, number, duration.
			missing.forEach((a, i) => fetched.set(a, ownTracks(lists[i]!, id).map((t) => unpackOwnTrack(packOwnTrack(toTrack(t)), cached.artist))));
		});
		await writeAppears(sql, id, fetched, now);
		await enforceCap(sql, id);
	}
	await countStats(sql, { hits: wanted.length - missing.length, misses: missing.length });
	await touchArtist(sql, id, now);
	const out = new Map([...wanted.filter((a) => have.has(a)).map((a) => [a, have.get(a)!] as const), ...fetched]);
	const mine = await trackMine(sql, [...out.values()].flat().map((t) => t.uri));
	return Object.fromEntries(
		wanted.map((a) => [a, (out.get(a) ?? []).map((t) => ({ ...t, ...(mine.get(t.uri) ?? { plays: 0, liked: false }) }))])
	);
}

/** Full album, live (never stored): cover, tracklist, your state per track. */
export async function catalogAlbum(sql: Queryable, client: CatalogClient, id: string): Promise<CatalogAlbum> {
	const { album, tracks } = await withCounters(sql, client, () => client.album(id));
	const r = toRelease(album, 'album');
	const mine = await trackMine(sql, tracks.map((t) => t.uri ?? `spotify:track:${t.id}`));
	const list = tracks.map((t) => toTrack(t, mine.get(t.uri ?? `spotify:track:${t.id}`)));
	const plays = list.reduce((n, t) => n + t.plays, 0);
	const liked = list.some((t) => t.liked);
	return {
		id: r.id,
		name: r.name,
		type: r.type,
		date: r.date,
		precision: r.precision,
		cover: r.cover,
		total: r.total || list.length,
		artists: (album.artists ?? []).map((a) => ({ id: a.id ?? null, name: a.name })),
		tracks: list,
		plays,
		liked,
		state: myState(plays, liked)
	};
}

type RawPage = { items?: unknown[]; total?: number; offset?: number } | undefined;

export async function catalogSearch(sql: Queryable, client: CatalogClient, q: string, types: SearchType[] = SEARCH_TYPES, offset = 0): Promise<CatalogSearchResults> {
	const query = q.trim().slice(0, 100);
	if (query.length < 2) return { q: query };
	const raw = await withCounters(sql, client, () => client.search(query, types, offset));
	const page = <T>(p: RawPage, map: (x: never) => T) => {
		const items = ((p?.items ?? []) as never[]).filter(Boolean).map(map);
		const total = p?.total ?? items.length;
		const off = p?.offset ?? offset;
		return { items, total, offset: off, next: off + items.length < total && items.length ? off + items.length : null };
	};
	const out: CatalogSearchResults = { q: query };
	if (types.includes('artist'))
		out.artists = page(raw.artists as RawPage, (a: { id: string; name: string; images?: { url: string; width?: number }[] }) => ({ id: a.id, name: a.name, image: pickImage(a.images) }));
	if (types.includes('album'))
		out.albums = page(raw.albums as RawPage, (a: SpAlbum) => {
			const r = toRelease(a, 'album');
			return { id: r.id, name: r.name, date: r.date, type: r.type, cover: r.cover, artists: (a.artists ?? []).map((x) => ({ id: x.id ?? null, name: x.name })) };
		});
	if (types.includes('track')) {
		const tracks = ((raw.tracks as RawPage)?.items ?? []) as SpTrack[];
		const mine = await trackMine(sql, tracks.filter(Boolean).map((t) => t.uri ?? `spotify:track:${t.id}`));
		out.tracks = page(raw.tracks as RawPage, (t: SpTrack) => ({
			...toTrack(t, mine.get(t.uri ?? `spotify:track:${t.id}`)),
			album: { id: t.album?.id ?? null, name: t.album?.name ?? '' }
		}));
	}
	return out;
}
