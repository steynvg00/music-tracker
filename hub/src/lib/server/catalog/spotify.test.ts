import { describe, expect, it } from 'vitest';
import { SpotifyApi, SpotifyError } from '$lib/server/spotify/api';
import { fakeFetch } from '$lib/server/test-helpers';
import { CatalogClient, Limiter, MAX_WAIT_S } from './spotify';

const ID = 'A'.repeat(22);

function client(route: Parameters<typeof fakeFetch>[0], sleeps: number[] = []) {
	const ff = fakeFetch(route);
	const api = new SpotifyApi({ getToken: async () => 'tok', fetch: ff.fetch });
	const sleep = async (ms: number) => void sleeps.push(ms);
	const c = new CatalogClient(api, { limiter: new Limiter(4, Date.now, sleep), sleep });
	return { c, calls: ff.calls, sleeps };
}

describe('v0.90 catalog client: concurrency', () => {
	it('never runs more than `max` tasks at once', async () => {
		const l = new Limiter(3);
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 20 }, () =>
				l.run(async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((r) => setTimeout(r, 2));
					active--;
				})
			)
		);
		expect(peak).toBe(3);
		expect(l.maxSeen).toBe(3);
	});
});

describe('v0.90 catalog client: 429 + Retry-After', () => {
	it('waits Retry-After and retries (short waits)', async () => {
		let n = 0;
		const { c, calls, sleeps } = client(() => (++n <= 2 ? { status: 429, body: { error: { status: 429, message: 'slow down' } }, headers: { 'retry-after': '2' } } : { status: 200, body: { id: ID, name: 'X' } }));
		const a = await c.artist(ID);
		expect(a.name).toBe('X');
		expect(calls.length).toBe(3);
		expect(sleeps.filter((s) => s === 2000).length).toBeGreaterThanOrEqual(2);
		expect(c.counters).toMatchObject({ calls: 3, rateLimited: 2 });
	});
	it('gives up on a Retry-After longer than the server may wait, passing the 429 on', async () => {
		const { c, calls } = client(() => ({ status: 429, body: {}, headers: { 'retry-after': String(MAX_WAIT_S + 27) } }));
		await expect(c.artist(ID)).rejects.toMatchObject({ status: 429, retryAfterS: MAX_WAIT_S + 27 });
		expect(calls.length).toBe(1);
	});
	it('gives up after MAX_RETRIES', async () => {
		const { c, calls } = client(() => ({ status: 429, body: {}, headers: { 'retry-after': '1' } }));
		await expect(c.artist(ID)).rejects.toBeInstanceOf(SpotifyError);
		expect(calls.length).toBe(3);
	});
});

describe('v0.90 catalog client: discography', () => {
	it('requests each include_groups value separately and pages by total', async () => {
		const albums = (g: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${({ album: 'L', single: 'S', appears_on: 'P' } as Record<string, string>)[g] ?? 'C'}${String(i).padStart(21, '0')}`, name: `${g} ${i}`, album_type: g === 'appears_on' ? 'compilation' : g, total_tracks: 3, release_date: '2020-01-01', release_date_precision: 'day', images: [] }));
		const all: Record<string, ReturnType<typeof albums>> = { album: albums('album', 3), single: albums('single', 120), compilation: [], appears_on: albums('appears_on', 51) };
		const { c, calls } = client((req) => {
			if (req.url.pathname === `/v1/artists/${ID}`) return { status: 200, body: { id: ID, name: 'Big', images: [{ url: 'https://i.scdn.co/image/x', width: 300 }] } };
			const g = req.url.searchParams.get('include_groups')!;
			const limit = Number(req.url.searchParams.get('limit'));
			const offset = Number(req.url.searchParams.get('offset'));
			expect(g.includes(',')).toBe(false);
			return { status: 200, body: { items: all[g]!.slice(offset, offset + limit), total: all[g]!.length } };
		});
		const d = await c.discography(ID);
		expect(d.releases.filter((r) => r.group === 'single')).toHaveLength(120);
		expect(d.releases.filter((r) => r.group === 'appears_on')).toHaveLength(51);
		expect(d.releases.filter((r) => r.group === 'compilation')).toHaveLength(0);
		// single: 3 pages of 50, appears_on: 2, album: 1, compilation: 1, artist: 1
		expect(calls.length).toBe(8);
	});
	it('falls back to 10 per page when Spotify refuses the larger limit', async () => {
		CatalogClient.albumPage = 50;
		const { c, calls } = client((req) => {
			if (req.url.pathname === `/v1/artists/${ID}`) return { status: 200, body: { id: ID, name: 'X' } };
			const limit = Number(req.url.searchParams.get('limit'));
			if (limit > 10) return { status: 400, body: { error: { status: 400, message: 'Invalid limit' } } };
			const offset = Number(req.url.searchParams.get('offset'));
			const items = Array.from({ length: 25 }, (_, i) => ({ id: `z${String(i).padStart(21, '0')}`, name: `r${i}` })).slice(offset, offset + limit);
			return { status: 200, body: { items, total: 25 } };
		});
		const rs = await c.releases(ID, 'album');
		expect(rs).toHaveLength(25);
		expect(CatalogClient.albumPage).toBe(10);
		expect(calls.map((x) => Number(x.url.searchParams.get('limit')))).toEqual([50, 10, 10, 10]);
		CatalogClient.albumPage = 50;
	});
});

describe('v0.90 catalog client: search', () => {
	it('asks for at most 10 per type (Feb 2026 cap)', async () => {
		const { c, calls } = client(() => ({ status: 200, body: { artists: { items: [], total: 0, offset: 0 } } }));
		await c.search('da tweekaz', ['artist', 'album', 'track'], 20);
		const q = calls[0]!.url.searchParams;
		expect(q.get('limit')).toBe('10');
		expect(q.get('offset')).toBe('20');
		expect(q.get('type')).toBe('artist,album,track');
	});
});
