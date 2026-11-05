import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeFetch, fakeSql } from '$lib/server/test-helpers';
import { ElsewhereUnavailable, importSoundCloud, importYouTube } from './elsewhere';
import { isoDurationMs, parseLink, playable, step } from '$lib/shared/elsewhere';
import { isPreview, widgetSrc } from '$lib/players/soundcloud';
import { BadInput } from '$lib/shared/custom';

describe('parseLink', () => {
	it('accepts YouTube playlist links in every common form', () => {
		for (const u of [
			'https://www.youtube.com/playlist?list=PLabcdefghij123',
			'https://youtube.com/playlist?list=PLabcdefghij123&si=x',
			'https://music.youtube.com/playlist?list=PLabcdefghij123',
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij123',
			'https://youtu.be/dQw4w9WgXcQ?list=PLabcdefghij123'
		]) {
			expect(parseLink(u)).toEqual({ source: 'youtube', kind: 'playlist', id: 'PLabcdefghij123', url: 'https://www.youtube.com/playlist?list=PLabcdefghij123' });
		}
		expect(parseLink('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ kind: 'manual', id: 'dQw4w9WgXcQ' });
	});
	it('refuses private lists, mixes and other hosts with a reason', () => {
		expect(parseLink('https://www.youtube.com/playlist?list=LL')).toHaveProperty('error');
		expect(parseLink('https://www.youtube.com/playlist?list=WL')).toHaveProperty('error');
		expect(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ')).toHaveProperty('error');
		expect(parseLink('https://vimeo.com/123')).toHaveProperty('error');
		expect(parseLink('not a url')).toHaveProperty('error');
		expect(parseLink('javascript:alert(1)')).toHaveProperty('error');
	});
	it('accepts SoundCloud sets and tracks (incl. secret links), refuses likes and short links', () => {
		expect(parseLink('https://soundcloud.com/artist/sets/my-set')).toEqual({ source: 'soundcloud', kind: 'set', id: 'https://soundcloud.com/artist/sets/my-set', url: 'https://soundcloud.com/artist/sets/my-set' });
		expect(parseLink('https://m.soundcloud.com/artist/sets/my-set/s-AbCd1234?utm=x')).toMatchObject({ kind: 'set', url: 'https://soundcloud.com/artist/sets/my-set/s-AbCd1234' });
		expect(parseLink('https://soundcloud.com/artist/a-track')).toMatchObject({ kind: 'manual' });
		expect(parseLink('https://soundcloud.com/artist/likes')).toHaveProperty('error');
		expect(parseLink('https://on.soundcloud.com/abc123')).toHaveProperty('error');
	});
});

describe('durations and stepping', () => {
	it('parses ISO-8601 durations', () => {
		expect(isoDurationMs('PT3M33S')).toBe(213_000);
		expect(isoDurationMs('PT1H2M3S')).toBe(3_723_000);
		expect(isoDurationMs('P1DT1S')).toBe(86_401_000);
		expect(isoDurationMs('PT')).toBeNull();
		expect(isoDurationMs('garbage')).toBeNull();
	});
	it('next/previous stay within the collection and skip what can’t play here', () => {
		const items = [
			{ embeddable: true, previewOnly: false, unavailable: false },
			{ embeddable: false, previewOnly: false, unavailable: false },
			{ embeddable: null, previewOnly: false, unavailable: false },
			{ embeddable: true, previewOnly: true, unavailable: false },
			{ embeddable: true, previewOnly: false, unavailable: true }
		];
		expect(step(items, 0, 1)).toBe(2);
		expect(step(items, 2, 1)).toBeNull(); // the end of THIS collection: never jumps elsewhere
		expect(step(items, 2, -1)).toBe(0);
		expect(step(items, -1, 1)).toBe(0);
		expect(items.map(playable)).toEqual([true, false, true, false, false]);
	});
	it('detects SoundCloud Go+ previews and builds a widget URL', () => {
		expect(isPreview({ policy: 'SNIP' })).toBe(true);
		expect(isPreview({ duration: 30_000, full_duration: 240_000 })).toBe(true);
		expect(isPreview({ policy: 'ALLOW', duration: 240_000, full_duration: 240_000 })).toBe(false);
		expect(widgetSrc('https://soundcloud.com/a/sets/b')).toBe('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fsets%2Fb&auto_play=false&visual=true&show_comments=false&show_reposts=false');
	});
});

function ytFetch(opts: { videos: { id: string; embeddable?: boolean }[]; missing?: string[]; perPage?: number }) {
	const per = opts.perPage ?? 50;
	return fakeFetch((req) => {
		const p = req.url.pathname;
		const q = req.url.searchParams;
		expect(q.get('key')).toBe('test-key');
		if (p.endsWith('/playlists')) return { status: 200, body: { items: [{ snippet: { title: 'My list', channelTitle: 'Me', thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } } } }] } };
		if (p.endsWith('/playlistItems')) {
			const start = Number(q.get('pageToken') ?? 0);
			const all = [...opts.videos.map((v) => v.id), ...(opts.missing ?? [])];
			const slice = all.slice(start, start + per);
			return { status: 200, body: { items: slice.map((videoId) => ({ contentDetails: { videoId } })), ...(start + per < all.length ? { nextPageToken: String(start + per) } : {}) } };
		}
		if (p.endsWith('/videos')) {
			const ids = q.get('id')!.split(',');
			return {
				status: 200,
				body: { items: opts.videos.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, snippet: { title: `Video ${v.id}`, channelTitle: 'Ch' }, contentDetails: { duration: 'PT3M' }, status: { embeddable: v.embeddable ?? true } })) }
			};
		}
		return undefined;
	});
}
const vid = (n: number) => `vid${String(n).padStart(8, '0')}`;

describe('importYouTube', () => {
	const link = { source: 'youtube' as const, kind: 'playlist' as const, id: 'PLabcdefghij123', url: 'https://www.youtube.com/playlist?list=PLabcdefghij123' };
	it('a 23-item playlist costs 3 quota units; deleted videos are left out; embeddable is stored', async () => {
		const videos = Array.from({ length: 22 }, (_, i) => ({ id: vid(i), embeddable: i !== 5 }));
		const ff = ytFetch({ videos, missing: ['deletedvid1'] });
		const { sql, queries } = fakeSql((q) => (q.text.startsWith('INSERT INTO collections') ? [{ id: 'c1', source: 'youtube', source_collection_id: link.id, kind: 'playlist', title: 'My list', owner_display: 'Me', url: link.url, artwork_url: null, item_count: 22, embed_html: null, imported_at: new Date(), last_synced_at: new Date(), last_import_units: 3 }] : q.text.startsWith('INSERT INTO media_items') ? [{ id: `m${queries.length}` }] : []));
		const r = await importYouTube(sql, 'test-key', link, ff.fetch);
		expect(r).toMatchObject({ units: 3, items: 22, notEmbeddable: 1 });
		expect(ff.calls.map((c) => c.url.pathname.split('/').at(-1))).toEqual(['playlists', 'playlistItems', 'videos']);
		expect(queries.filter((q) => q.text.startsWith('INSERT INTO collection_items'))).toHaveLength(22);
		expect(ff.calls.every((c) => c.url.host === 'www.googleapis.com')).toBe(true);
	});
	it('pages through long playlists (1 unit per 50)', async () => {
		const videos = Array.from({ length: 120 }, (_, i) => ({ id: vid(i) }));
		const ff = ytFetch({ videos });
		const { sql } = fakeSql((q) => (q.text.startsWith('INSERT INTO collections') ? [{ id: 'c1', source: 'youtube', imported_at: new Date(), last_synced_at: new Date() }] : q.text.startsWith('INSERT INTO media_items') ? [{ id: 'm' }] : []));
		const r = await importYouTube(sql, 'test-key', link, ff.fetch);
		expect(r.units).toBe(1 + 3 + 3);
	});
	it('without an API key nothing is fetched', async () => {
		const ff = ytFetch({ videos: [] });
		const { sql } = fakeSql(() => []);
		await expect(importYouTube(sql, null, link, ff.fetch)).rejects.toBeInstanceOf(ElsewhereUnavailable);
		expect(ff.calls).toHaveLength(0);
	});
	it('a private playlist is a clear bad request', async () => {
		const ff = fakeFetch(() => ({ status: 200, body: { items: [] } }));
		const { sql } = fakeSql(() => []);
		await expect(importYouTube(sql, 'k', link, ff.fetch)).rejects.toBeInstanceOf(BadInput);
	});
});

describe('importSoundCloud', () => {
	const link = { source: 'soundcloud' as const, kind: 'set' as const, id: 'https://soundcloud.com/a/sets/b', url: 'https://soundcloud.com/a/sets/b' };
	it('uses keyless oEmbed and stores the official widget html', async () => {
		const ff = fakeFetch((req) => {
			expect(req.url.href.startsWith('https://soundcloud.com/oembed?')).toBe(true);
			expect(req.url.searchParams.get('url')).toBe(link.url);
			return { status: 200, body: { title: 'Set B', author_name: 'A', html: '<iframe src="https://w.soundcloud.com/player/?url=x"></iframe>' } };
		});
		const { sql, queries } = fakeSql((q) => (q.text.startsWith('INSERT INTO collections') ? [{ id: 'c1', source: 'soundcloud', imported_at: new Date(), last_synced_at: new Date() }] : q.text.startsWith('INSERT INTO media_items') ? [{ id: 'm1' }] : []));
		const r = await importSoundCloud(sql, link, ff.fetch);
		expect(r.items).toBe(1);
		expect(queries.find((q) => q.text.startsWith('INSERT INTO collections'))!.values).toContain('<iframe src="https://w.soundcloud.com/player/?url=x"></iframe>');
	});
	it('refuses an oEmbed answer without the official player', async () => {
		const ff = fakeFetch(() => ({ status: 200, body: { title: 'x', html: '<script>alert(1)</script>' } }));
		const { sql } = fakeSql(() => []);
		await expect(importSoundCloud(sql, link, ff.fetch)).rejects.toBeInstanceOf(ElsewhereUnavailable);
	});
});

describe('separate rooms', () => {
	const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
	it('Spotify lists, shelves, search and stats never read the Elsewhere tables', () => {
		for (const f of ['./library.ts', './stats/core.ts', './stats/sections.ts', './stats/detail.ts', './daily.ts']) {
			expect(src(f), f).not.toMatch(/media_items|collection_items|\bcollections\b/);
		}
	});
	it('Home only counts collections: no artwork or items', () => {
		const home = src('./home.ts');
		expect(home).toContain('countCollections');
		expect(home).not.toMatch(/media_items|collection_items|getCollection|listCollections/);
	});
});
