/**
 * Elsewhere collections (R4), server side. Imports are interactive (< 1 s for a normal
 * playlist), so they run here; the 30-day metadata refresh is Python (scripts/refresh_collections.py).
 *
 * YouTube: Data API v3 with a server-side API key (public or unlisted playlists only):
 *   playlists.list (1 unit) + playlistItems.list (1 unit / 50) + videos.list (1 unit / 50).
 *   A 20-item playlist costs 3 units. status.embeddable is stored: non-embeddable videos are
 *   flagged and skipped by the player (YouTube error 101/150 otherwise).
 * SoundCloud: oEmbed, no key. The widget plays the whole set; Go+ previews are flagged by the
 *   player at play time (the widget reports them) and skipped.
 *
 * Terms (01-feasibility.md §4–5): metadata is shown as returned, the player stays visible and
 * intact, nothing is downloaded or extracted, stored API data is refreshed within 30 days.
 */
import type { Queryable } from '$lib/server/db';
import { BadInput } from '$lib/shared/custom';
import { REFRESH_DAYS, isoDurationMs, type Collection, type CollectionDetail, type MediaItem, type ParsedLink, type Source } from '$lib/shared/elsewhere';

export const YT_API = 'https://www.googleapis.com/youtube/v3';
export const SC_OEMBED = 'https://soundcloud.com/oembed';
const MAX_YT_ITEMS = 500;

export class ElsewhereUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ElsewhereUnavailable';
	}
}

interface YtThumbs {
	default?: { url: string };
	medium?: { url: string };
	high?: { url: string };
	standard?: { url: string };
}
const thumb = (t: YtThumbs | undefined) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;

async function ytGet<T>(f: typeof fetch, path: string, params: Record<string, string>, key: string): Promise<T> {
	const q = new URLSearchParams({ ...params, key });
	const res = await f(`${YT_API}/${path}?${q}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
	if (res.status === 403) throw new ElsewhereUnavailable('YouTube refused the request (API key restrictions or quota). Check YOUTUBE_API_KEY.');
	if (res.status === 404) throw new BadInput('YouTube says that playlist doesn’t exist');
	if (!res.ok) throw new ElsewhereUnavailable(`YouTube answered ${res.status}`);
	return (await res.json()) as T;
}

interface YtVideo {
	id: string;
	snippet?: { title?: string; channelTitle?: string; thumbnails?: YtThumbs };
	contentDetails?: { duration?: string };
	status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
}

export interface ImportResult {
	collection: Collection;
	units: number;
	items: number;
	notEmbeddable: number;
}

/** YouTube playlist (or one video as a single-item collection). */
export async function importYouTube(sql: Queryable, key: string | null, link: Extract<ParsedLink, { source: 'youtube' }>, f: typeof fetch = fetch): Promise<ImportResult> {
	if (!key) throw new ElsewhereUnavailable('YouTube import needs YOUTUBE_API_KEY in the Vercel env (see the PR setup steps)');
	let units = 0;
	let title: string;
	let owner: string | null = null;
	let art: string | null = null;
	let videoIds: string[] = [];
	if (link.kind === 'playlist') {
		const pl = await ytGet<{ items?: { snippet?: { title?: string; channelTitle?: string; thumbnails?: YtThumbs } }[] }>(f, 'playlists', { part: 'snippet,contentDetails', id: link.id, maxResults: '1' }, key);
		units++;
		const p = pl.items?.[0];
		if (!p) throw new BadInput('That playlist is private or doesn’t exist. Make it public or unlisted, then try again.');
		title = p.snippet?.title ?? 'YouTube playlist';
		owner = p.snippet?.channelTitle ?? null;
		art = thumb(p.snippet?.thumbnails);
		let pageToken = '';
		do {
			const page = await ytGet<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>(
				f,
				'playlistItems',
				{ part: 'contentDetails', playlistId: link.id, maxResults: '50', ...(pageToken ? { pageToken } : {}) },
				key
			);
			units++;
			for (const it of page.items ?? []) if (it.contentDetails?.videoId) videoIds.push(it.contentDetails.videoId);
			pageToken = page.nextPageToken ?? '';
		} while (pageToken && videoIds.length < MAX_YT_ITEMS);
		videoIds = [...new Set(videoIds)].slice(0, MAX_YT_ITEMS);
	} else {
		videoIds = [link.id];
		title = '';
	}
	const videos = new Map<string, YtVideo>();
	for (let i = 0; i < videoIds.length; i += 50) {
		const page = await ytGet<{ items?: YtVideo[] }>(f, 'videos', { part: 'snippet,contentDetails,status', id: videoIds.slice(i, i + 50).join(','), maxResults: '50' }, key);
		units++;
		for (const v of page.items ?? []) videos.set(v.id, v);
	}
	if (link.kind === 'manual') {
		const v = videos.get(link.id);
		if (!v) throw new BadInput('That video is private or doesn’t exist');
		title = v.snippet?.title ?? 'YouTube video';
		owner = v.snippet?.channelTitle ?? null;
		art = thumb(v.snippet?.thumbnails);
	}
	// Deleted/private videos come back from playlistItems but not from videos.list: they're left out.
	const items = videoIds
		.map((id) => videos.get(id))
		.filter((v): v is YtVideo => !!v)
		.map((v) => ({
			sourceId: v.id,
			title: v.snippet?.title ?? v.id,
			artist: v.snippet?.channelTitle ?? null,
			durationMs: isoDurationMs(v.contentDetails?.duration),
			artworkUrl: thumb(v.snippet?.thumbnails),
			embeddable: v.status?.embeddable ?? null,
			raw: { privacyStatus: v.status?.privacyStatus ?? null }
		}));
	const collection = await saveCollection(sql, {
		source: 'youtube',
		sourceCollectionId: link.id,
		kind: link.kind,
		title,
		owner,
		url: link.url,
		artworkUrl: art,
		embedHtml: null,
		units,
		items
	});
	return { collection, units, items: items.length, notEmbeddable: items.filter((i) => i.embeddable === false).length };
}

interface OEmbed {
	title?: string;
	author_name?: string;
	thumbnail_url?: string;
	html?: string;
	type?: string;
}

/** SoundCloud set or track via oEmbed (no key). One item: the widget plays the set itself. */
export async function importSoundCloud(sql: Queryable, link: Extract<ParsedLink, { source: 'soundcloud' }>, f: typeof fetch = fetch): Promise<ImportResult> {
	const res = await f(`${SC_OEMBED}?${new URLSearchParams({ format: 'json', url: link.url })}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
	if (res.status === 404 || res.status === 403) throw new BadInput('SoundCloud can’t find that link (private sets need their secret link)');
	if (!res.ok) throw new ElsewhereUnavailable(`SoundCloud answered ${res.status}`);
	const o = (await res.json()) as OEmbed;
	if (!o.html || !/src="https:\/\/w\.soundcloud\.com\/player\//.test(o.html)) throw new ElsewhereUnavailable('SoundCloud returned no player for that link');
	const collection = await saveCollection(sql, {
		source: 'soundcloud',
		sourceCollectionId: link.url,
		kind: link.kind,
		title: o.title ?? link.url,
		owner: o.author_name ?? null,
		url: link.url,
		artworkUrl: o.thumbnail_url ?? null,
		embedHtml: o.html,
		units: null,
		items: [{ sourceId: link.url, title: o.title ?? link.url, artist: o.author_name ?? null, durationMs: null, artworkUrl: o.thumbnail_url ?? null, embeddable: true, raw: {} }]
	});
	return { collection, units: 0, items: 1, notEmbeddable: 0 };
}

interface SaveInput {
	source: Source;
	sourceCollectionId: string;
	kind: Collection['kind'];
	title: string;
	owner: string | null;
	url: string;
	artworkUrl: string | null;
	embedHtml: string | null;
	units: number | null;
	items: { sourceId: string; title: string; artist: string | null; durationMs: number | null; artworkUrl: string | null; embeddable: boolean | null; raw: Record<string, unknown> }[];
}

async function saveCollection(sql: Queryable, c: SaveInput): Promise<Collection> {
	const [row] = await sql<CollectionRow[]>`
		INSERT INTO collections (source, source_collection_id, kind, title, owner_display, url, artwork_url, item_count, embed_html, last_synced_at, last_import_units)
		VALUES (${c.source}, ${c.sourceCollectionId}, ${c.kind}, ${c.title}, ${c.owner}, ${c.url}, ${c.artworkUrl}, ${c.items.length}, ${c.embedHtml}, now(), ${c.units})
		ON CONFLICT (source, source_collection_id) DO UPDATE SET
			title = EXCLUDED.title, owner_display = EXCLUDED.owner_display, url = EXCLUDED.url, artwork_url = EXCLUDED.artwork_url,
			item_count = EXCLUDED.item_count, embed_html = EXCLUDED.embed_html, last_synced_at = now(), last_import_units = EXCLUDED.last_import_units
		RETURNING *`;
	await sql`DELETE FROM collection_items WHERE collection_id = ${row!.id}`;
	for (let i = 0; i < c.items.length; i++) {
		const it = c.items[i]!;
		const [m] = await sql<{ id: string }[]>`
			INSERT INTO media_items (source, source_id, title, artist_display, duration_ms, artwork_url, embeddable, unavailable, last_checked_at, raw)
			VALUES (${c.source}, ${it.sourceId}, ${it.title}, ${it.artist}, ${it.durationMs}, ${it.artworkUrl}, ${it.embeddable}, false, now(), ${JSON.stringify(it.raw)}::text::jsonb)
			ON CONFLICT (source, source_id) DO UPDATE SET
				title = EXCLUDED.title, artist_display = EXCLUDED.artist_display, duration_ms = coalesce(EXCLUDED.duration_ms, media_items.duration_ms),
				artwork_url = EXCLUDED.artwork_url, embeddable = EXCLUDED.embeddable, unavailable = false, last_checked_at = now(), raw = EXCLUDED.raw
			RETURNING id`;
		await sql`INSERT INTO collection_items (collection_id, position, media_item_id) VALUES (${row!.id}, ${i}, ${m!.id})`;
	}
	return toCollection(row!);
}

interface CollectionRow {
	id: string;
	source: Source;
	source_collection_id: string;
	kind: Collection['kind'];
	title: string;
	owner_display: string | null;
	url: string;
	artwork_url: string | null;
	item_count: number;
	embed_html: string | null;
	imported_at: Date;
	last_synced_at: Date;
	last_import_units: number | null;
}

function toCollection(r: CollectionRow): Collection {
	return {
		id: r.id,
		source: r.source,
		sourceCollectionId: r.source_collection_id,
		kind: r.kind,
		title: r.title,
		owner: r.owner_display,
		url: r.url,
		artworkUrl: r.artwork_url,
		itemCount: r.item_count,
		embedHtml: r.embed_html,
		importedAt: new Date(r.imported_at).toISOString(),
		lastSyncedAt: new Date(r.last_synced_at).toISOString(),
		lastImportUnits: r.last_import_units
	};
}

export async function listCollections(sql: Queryable, source: Source | null = null): Promise<Collection[]> {
	const rows = source
		? await sql<CollectionRow[]>`SELECT * FROM collections WHERE source = ${source} ORDER BY imported_at DESC`
		: await sql<CollectionRow[]>`SELECT * FROM collections ORDER BY imported_at DESC`;
	return rows.map(toCollection);
}

export async function countCollections(sql: Queryable): Promise<{ youtube: number; soundcloud: number }> {
	const rows = await sql<{ source: Source; n: number }[]>`SELECT source, count(*)::int AS n FROM collections GROUP BY source`;
	return { youtube: rows.find((r) => r.source === 'youtube')?.n ?? 0, soundcloud: rows.find((r) => r.source === 'soundcloud')?.n ?? 0 };
}

export async function getCollection(sql: Queryable, id: string): Promise<CollectionDetail | null> {
	const [row] = await sql<CollectionRow[]>`SELECT * FROM collections WHERE id = ${id}`;
	if (!row) return null;
	const items = await sql<
		{ id: string; source: Source; source_id: string; title: string; artist_display: string | null; duration_ms: number | null; artwork_url: string | null; embeddable: boolean | null; is_preview_only: boolean; unavailable: boolean; position: number; last_checked_at: Date }[]
	>`
		SELECT m.*, ci.position FROM collection_items ci JOIN media_items m ON m.id = ci.media_item_id
		WHERE ci.collection_id = ${id} ORDER BY ci.position`;
	const oldest = items.reduce<Date | null>((o, i) => (!o || i.last_checked_at < o ? i.last_checked_at : o), null);
	return {
		...toCollection(row),
		items: items.map(
			(i): MediaItem => ({
				id: i.id,
				source: i.source,
				sourceId: i.source_id,
				title: i.title,
				artist: i.artist_display,
				durationMs: i.duration_ms,
				artworkUrl: i.artwork_url,
				embeddable: i.embeddable,
				previewOnly: i.is_preview_only,
				unavailable: i.unavailable,
				position: i.position
			})
		),
		staleAfter: new Date((oldest ? new Date(oldest).getTime() : Date.now()) + REFRESH_DAYS * 86_400_000).toISOString()
	};
}

export async function deleteCollection(sql: Queryable, id: string): Promise<boolean> {
	const r = await sql`DELETE FROM collections WHERE id = ${id}`;
	// Media items no other collection uses go too (nothing kept beyond what you imported).
	await sql`DELETE FROM media_items m WHERE NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.media_item_id = m.id)`;
	return r.count > 0;
}

/**
 * What the player learned at play time: a YouTube video that refused to embed (101/150) or a
 * SoundCloud Go+ preview. Only flags can be set here; titles etc. come from the APIs.
 */
export async function flagItem(sql: Queryable, collectionId: string, mediaItemId: string, flag: 'not_embeddable' | 'preview_only' | 'unavailable'): Promise<boolean> {
	const r =
		flag === 'not_embeddable'
			? await sql`UPDATE media_items m SET embeddable = false FROM collection_items ci WHERE ci.media_item_id = m.id AND ci.collection_id = ${collectionId} AND m.id = ${mediaItemId}`
			: flag === 'preview_only'
				? await sql`UPDATE media_items m SET is_preview_only = true FROM collection_items ci WHERE ci.media_item_id = m.id AND ci.collection_id = ${collectionId} AND m.id = ${mediaItemId}`
				: await sql`UPDATE media_items m SET unavailable = true FROM collection_items ci WHERE ci.media_item_id = m.id AND ci.collection_id = ${collectionId} AND m.id = ${mediaItemId}`;
	return r.count > 0;
}
