/**
 * E2E mock of every external service Rotor talks to (Spotify Web API + Accounts, GitHub
 * Actions dispatch; R4 adds YouTube Data API + SoundCloud oEmbed; R7 adds MusicBrainz + the Scantraxx
 * monthly release pages and Spotify artist albums). One in-memory state,
 * one call log. Used two ways:
 *   - in the hub's Node process, through preload.mjs (globalThis.fetch is wrapped);
 *   - over HTTP on 127.0.0.1:<E2E_MOCK_PORT>/v1/… for the Python job runner (spotipy prefix).
 * Nothing here ever reaches the network.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const id22 = () => randomBytes(16).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 22).padEnd(22, 'x');
const HUB_SCOPES =
	'user-read-playback-state user-modify-playback-state user-read-currently-playing streaming user-read-email user-read-private ' +
	'playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-library-modify';

export function createMock(stateFile) {
	const initial = JSON.parse(readFileSync(stateFile, 'utf8'));
	let state = structuredClone(initial);
	let calls = [];
	let snap = 1;
	const listeners = { dispatch: [] };

	const err = (status, message) => ({ status, body: { error: { status, message } } });
	const ok = (body, status = 200) => ({ status, body });
	const none = () => ({ status: 204 });

	const track = (uri) => {
		const t = state.tracks[uri];
		const id = uri.split(':')[2];
		if (!t) return { uri, id, type: 'track', name: `Track ${id.slice(0, 6)}`, duration_ms: 200000, artists: [], album: { name: '', images: [] }, is_local: false };
		return {
			uri,
			id,
			type: 'track',
			name: t.name,
			duration_ms: t.duration_ms ?? 200000,
			artists: (t.artists ?? []).map((a) => ({ name: a.name, id: a.id, uri: `spotify:artist:${a.id}` })),
			album: { name: t.album?.name ?? '', id: t.album?.id ?? null, images: [] },
			is_local: false
		};
	};
	const plObj = (p, full = true) => ({
		id: p.id,
		name: p.name,
		description: p.description ?? '',
		owner: { id: p.owner, display_name: p.owner === state.owner ? 'E2E Owner' : 'Someone else' },
		collaborative: !!p.collaborative,
		public: !!p.public,
		snapshot_id: p.snapshot_id,
		images: p.image ? [{ url: p.image, width: 300, height: 300 }] : [],
		items: { total: p.items.length },
		tracks: { total: p.items.length },
		uri: `spotify:playlist:${p.id}`,
		...(full ? {} : {})
	});
	const owned = (p) => p.owner === state.owner || p.collaborative;
	const bump = (p) => (p.snapshot_id = `snap-${p.id.slice(0, 4)}-${++snap}`);
	const device = (idOrNull) => state.devices.find((d) => d.id === idOrNull) ?? null;
	const activeDevice = () => state.devices.find((d) => d.is_active) ?? null;

	function playbackBody() {
		const pb = state.playback;
		if (!pb) return null;
		const d = device(pb.device_id);
		return {
			device: d,
			is_playing: pb.is_playing,
			progress_ms: pb.progress_ms ?? 0,
			timestamp: Date.now(),
			shuffle_state: !!pb.shuffle,
			repeat_state: pb.repeat ?? 'off',
			currently_playing_type: 'track',
			item: pb.item_uri ? track(pb.item_uri) : null,
			context: pb.context_uri ? { uri: pb.context_uri, type: pb.context_uri.split(':')[1] } : null,
			actions: { disallows: {} }
		};
	}

	function contextItems(contextUri) {
		const m = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(contextUri ?? '');
		return m && state.playlists[m[1]] ? state.playlists[m[1]].items : [];
	}

	// ── v0.90: Spotify catalog for the Artist pages (beta) + catalog search ──────────────────────
	// state.catalog = { artists: { [id]: { name, gen?: {album, single, compilation, appears_on}, explicit?: {group: [albumId]} } },
	//                   albums: { [explicitId]: album-with-tracks }, fail429: n, retryAfter: s }
	// Synthetic albums/tracks are generated from their id (artist prefix + group + index), so a 600-release
	// artist costs nothing in the state file and every id resolves the same way on every call.
	const GROUP_CHAR = { album: 'L', single: 'S', compilation: 'C', appears_on: 'P' };
	const CHAR_GROUP = { L: 'album', S: 'single', C: 'compilation', P: 'appears_on' };
	const pad = (n, w) => String(n).padStart(w, '0');
	// Real cover ids are 40 random-looking hex chars: use SHA-1 so they compress like real ones.
	const hex40 = (seed) => createHash('sha1').update(seed).digest('hex');
	const images = (seed) => [640, 300, 64].map((w) => ({ url: `https://i.scdn.co/image/ab67616d0000${w === 640 ? 'b273' : w === 300 ? '1e02' : '4851'}${hex40(seed)}`, width: w, height: w }));
	const cat = () => state.catalog ?? { artists: {}, albums: {} };
	const byPrefix = (pre) => Object.keys(cat().artists).find((id) => id.slice(0, 13) === pre) ?? null;
	function genAlbumMeta(artistId, g, i) {
		const a = cat().artists[artistId];
		const n = a?.gen?.[g] ?? 0;
		const total = g === 'album' ? 12 : g === 'single' ? (i % 5 === 0 ? 5 : 1 + (i % 3)) : g === 'compilation' ? 20 : i % 10 === 0 ? 64 : 10 + (i % 30);
		const year = 2026 - Math.floor((i * 15) / Math.max(n, 1));
		const precision = i % 9 === 4 ? 'year' : i % 7 === 3 ? 'month' : 'day';
		const date = precision === 'year' ? `${year}` : precision === 'month' ? `${year}-${pad(1 + ((i * 7) % 12), 2)}` : `${year}-${pad(1 + ((i * 7) % 12), 2)}-${pad(1 + ((i * 11) % 28), 2)}`;
		const id = `${artistId.slice(0, 13)}${GROUP_CHAR[g]}${pad(i, 4)}aaaa`;
		const label = { album: 'Album', single: 'Single', compilation: 'Collected', appears_on: 'Various Hardstyle Vol.' }[g];
		return {
			id,
			name: g === 'appears_on' ? `${label} ${i + 1}` : `${a?.name ?? 'Artist'} ${label} ${i + 1}`,
			album_type: g === 'appears_on' ? ['compilation', 'album', 'single'][i % 3] : g,
			total_tracks: total,
			release_date: date,
			release_date_precision: precision,
			images: images(id),
			artists: g === 'appears_on' ? [{ id: null, name: 'Various Artists' }] : [{ id: artistId, name: a?.name ?? 'Artist' }],
			uri: `spotify:album:${id}`
		};
	}
	function genTracks(artistId, g, i, meta) {
		const a = cat().artists[artistId];
		const own = new Set(g === 'appears_on' ? [1 + (i % meta.total_tracks), ...(i % 4 === 0 ? [1 + ((i + 3) % meta.total_tracks)] : [])] : []);
		return Array.from({ length: meta.total_tracks }, (_, k) => {
			const tn = k + 1;
			const id = `${artistId.slice(0, 13)}${GROUP_CHAR[g]}${pad(i, 4)}t${pad(tn % 100, 2)}x`;
			const mine = g !== 'appears_on' || own.has(tn);
			const guest = { id: `Guest${pad(tn, 3)}${'g'.repeat(14)}`, name: `Guest ${tn}` };
			return {
				id,
				uri: `spotify:track:${id}`,
				name: g === 'appears_on' ? (mine ? `${a?.name ?? 'Artist'} – Anthem ${i + 1}.${tn}` : `Guest track ${i + 1}.${tn}`) : `${meta.name} – ${tn}`,
				track_number: tn,
				disc_number: 1,
				duration_ms: 180000 + ((i * 37 + tn * 13) % 120) * 1000,
				artists: mine ? (g === 'appears_on' && tn % 2 ? [guest, { id: artistId, name: a?.name }] : [{ id: artistId, name: a?.name }]) : [guest]
			};
		});
	}
	/** Album (with tracks) for an explicit or synthetic id, or null. */
	function catalogAlbum(id) {
		const ex = cat().albums?.[id];
		if (ex) return ex;
		const m = /^(.{13})([LSCP])(\d{4})aaaa$/.exec(id);
		const artistId = m && byPrefix(m[1]);
		if (!artistId) return null;
		const g = CHAR_GROUP[m[2]];
		const i = Number(m[3]);
		if (i >= (cat().artists[artistId].gen?.[g] ?? 0)) return null;
		const meta = genAlbumMeta(artistId, g, i);
		return { ...meta, tracks: genTracks(artistId, g, i, meta) };
	}
	function artistReleases(artistId, g) {
		const a = cat().artists[artistId];
		const ex = (a.explicit?.[g] ?? []).map((id) => {
			const { tracks: _t, ...meta } = cat().albums[id];
			return meta;
		});
		const gen = Array.from({ length: a.gen?.[g] ?? 0 }, (_, i) => genAlbumMeta(artistId, g, i));
		return [...ex, ...gen];
	}
	const page = (list, query, max = 50) => {
		const limit = Number(query.get('limit') ?? 20);
		const offset = Number(query.get('offset') ?? 0);
		if (limit > max || limit < 1) return err(400, `Invalid limit (max ${max})`);
		const items = list.slice(offset, offset + limit);
		return ok({ items, total: list.length, limit, offset, next: offset + limit < list.length ? 'next' : null });
	};
	function catalogApi(method, p, query) {
		if (method !== 'GET') return null;
		const c = cat();
		const isCatalogPath = /^\/(artists|albums)\/|^\/search$/.test(p);
		if (!isCatalogPath) return null;
		let m;
		const known =
			p === '/search' ||
			((m = /^\/artists\/([A-Za-z0-9]{22})(?:\/albums)?$/.exec(p)) && c.artists?.[m[1]]) ||
			((m = /^\/albums\/([A-Za-z0-9]{22})(?:\/tracks)?$/.exec(p)) && catalogAlbum(m[1]));
		if (!known) return null;
		if (c.fail429 > 0) {
			c.fail429--;
			return { status: 429, body: { error: { status: 429, message: 'API rate limit exceeded' } }, headers: { 'retry-after': String(c.retryAfter ?? 1) } };
		}
		if ((m = /^\/artists\/([A-Za-z0-9]{22})$/.exec(p))) {
			const a = c.artists[m[1]];
			return ok({ id: m[1], name: a.name, type: 'artist', uri: `spotify:artist:${m[1]}`, images: a.noImage ? [] : images(m[1]) });
		}
		if ((m = /^\/artists\/([A-Za-z0-9]{22})\/albums$/.exec(p))) {
			const g = query.get('include_groups') ?? '';
			if (!GROUP_CHAR[g]) return err(400, 'E2E mock: request ONE include_groups value at a time');
			return page(artistReleases(m[1], g), query, c.maxAlbumsLimit ?? 50);
		}
		if ((m = /^\/albums\/([A-Za-z0-9]{22})\/tracks$/.exec(p))) return page(catalogAlbum(m[1]).tracks, query, 50);
		if ((m = /^\/albums\/([A-Za-z0-9]{22})$/.exec(p))) {
			const a = catalogAlbum(m[1]);
			const { tracks, ...meta } = a;
			return ok({ ...meta, tracks: { items: tracks.slice(0, 50), total: tracks.length, limit: 50, offset: 0, next: tracks.length > 50 ? 'next' : null } });
		}
		if (p === '/search') {
			const limit = Number(query.get('limit') ?? 20);
			if (limit > 10) return err(400, 'Invalid limit (max 10 since Feb 2026)');
			const q = (query.get('q') ?? '').toLowerCase();
			const types = (query.get('type') ?? '').split(',');
			const out = {};
			const slice = (list) => {
				const offset = Number(query.get('offset') ?? 0);
				return { items: list.slice(offset, offset + limit), total: list.length, limit, offset, next: offset + limit < list.length ? 'next' : null };
			};
			const matched = Object.entries(c.artists ?? {}).filter(([, a]) => a.name.toLowerCase().includes(q));
			if (types.includes('artist')) {
				const fillers = Array.from({ length: 21 }, (_, k) => ({ id: `SrchFillerArtist${pad(k, 6)}`, name: `${query.get('q')} tribute ${k + 1}`, type: 'artist', images: [] }));
				out.artists = slice([...matched.map(([id, a]) => ({ id, name: a.name, type: 'artist', images: images(id) })), ...fillers]);
			}
			const pool = (c.searchPool ?? []).filter((id) => c.artists[id]);
			const albums = pool.flatMap((id) => [...artistReleases(id, 'album'), ...artistReleases(id, 'single')]);
			if (types.includes('album')) out.albums = slice(albums);
			if (types.includes('track')) out.tracks = slice(albums.map((al) => ({ ...catalogAlbum(al.id).tracks[0], album: { id: al.id, name: al.name, images: al.images } })));
			return ok(out);
		}
		return null;
	}

	function spotifyApi(method, path, query, body, who = 'hub') {
		const p = path.replace(/^\/v1/, '').replace(/\/+$/, '') || '/';
		let m;
		if (who === 'hub') {
			const c = catalogApi(method, p, query);
			if (c) return c;
		}
		// v0.92: state.failNext = { path, status, count } makes the next `count` calls to `path` fail (player rollback tests).
		const fn = state.failNext;
		if (fn && fn.count > 0 && p === fn.path) {
			fn.count--;
			return err(fn.status ?? 502, 'E2E: injected failure');
		}
		if (method === 'GET' && p === '/me') return ok({ id: state.loginUser ?? state.owner, display_name: 'E2E', product: 'premium', country: 'NL', email: 'e2e@example.invalid' });
		// ── player ──
		if (method === 'GET' && p === '/me/player') return state.playback ? ok(playbackBody()) : none();
		if (method === 'GET' && p === '/me/player/currently-playing') return state.playback ? ok(playbackBody()) : none();
		if (method === 'GET' && p === '/me/player/devices') return ok({ devices: state.devices });
		if (method === 'GET' && p === '/me/player/queue') return ok({ currently_playing: state.playback?.item_uri ? track(state.playback.item_uri) : null, queue: [] });
		if (method === 'PUT' && p === '/me/player/play') {
			const did = query.get('device_id') ?? activeDevice()?.id ?? null;
			const d = device(did);
			if (!d) return err(404, 'Device not found');
			state.devices.forEach((x) => (x.is_active = x.id === d.id));
			const prev = state.playback;
			if (!body || (!body.context_uri && !body.uris)) {
				if (!prev) return err(404, 'No active playback');
				state.playback = { ...prev, device_id: d.id, is_playing: true };
				return none();
			}
			const list = body.uris ?? contextItems(body.context_uri);
			const off = typeof body.offset?.position === 'number' ? body.offset.position : body.offset?.uri ? Math.max(0, list.indexOf(body.offset.uri)) : 0;
			state.playback = {
				device_id: d.id,
				is_playing: true,
				item_uri: list[off] ?? list[0] ?? null,
				progress_ms: body.position_ms ?? 0,
				context_uri: body.context_uri ?? null,
				list,
				index: off,
				shuffle: prev?.shuffle ?? false,
				repeat: prev?.repeat ?? 'off'
			};
			return none();
		}
		if (method === 'PUT' && p === '/me/player/pause') {
			if (!state.playback) return err(404, 'No active device');
			state.playback.is_playing = false;
			return none();
		}
		if (method === 'POST' && (p === '/me/player/next' || p === '/me/player/previous')) {
			const pb = state.playback;
			if (!pb) return err(404, 'No active device');
			const list = pb.list ?? contextItems(pb.context_uri);
			pb.index = Math.max(0, Math.min(list.length - 1, (pb.index ?? 0) + (p.endsWith('next') ? 1 : -1)));
			pb.item_uri = list[pb.index] ?? pb.item_uri;
			pb.progress_ms = 0;
			return none();
		}
		if (method === 'PUT' && p === '/me/player/seek') {
			if (state.playback) state.playback.progress_ms = Number(query.get('position_ms') ?? 0);
			return none();
		}
		if (method === 'PUT' && (p === '/me/player/volume' || p === '/me/player/shuffle' || p === '/me/player/repeat')) {
			if (state.playback && p.endsWith('shuffle')) state.playback.shuffle = query.get('state') === 'true';
			if (state.playback && p.endsWith('repeat')) state.playback.repeat = query.get('state');
			return none();
		}
		if (method === 'PUT' && p === '/me/player') {
			const did = body?.device_ids?.[0];
			if (!device(did)) return err(404, 'Device not found');
			state.devices.forEach((x) => (x.is_active = x.id === did));
			if (state.playback) state.playback.device_id = did;
			return none();
		}
		if (method === 'POST' && p === '/me/player/queue') return none();
		// ── playlists ──
		if (method === 'GET' && p === '/me/playlists') {
			const limit = Number(query.get('limit') ?? 20);
			const offset = Number(query.get('offset') ?? 0);
			const all = state.library.map((pid) => state.playlists[pid]).filter(Boolean);
			const items = all.slice(offset, offset + limit).map((x) => plObj(x, false));
			return ok({ items, total: all.length, limit, offset, next: offset + limit < all.length ? `https://api.spotify.com/v1/me/playlists?offset=${offset + limit}&limit=${limit}` : null });
		}
		if (method === 'POST' && (p === '/me/playlists' || /^\/users\/[^/]+\/playlists$/.test(p))) {
			const pid = id22();
			state.playlists[pid] = { id: pid, name: body?.name ?? 'Untitled', description: body?.description ?? '', owner: state.owner, public: !!body?.public, items: [], snapshot_id: `snap-${pid.slice(0, 4)}-1` };
			state.library.unshift(pid);
			return ok(plObj(state.playlists[pid]), 201);
		}
		if (method === 'DELETE' && p === '/me/library') {
			const uris = (query.get('uris') ?? '').split(',').filter(Boolean);
			if (!state.libraryModifyGranted) return err(403, 'Insufficient client scope');
			for (const u of uris) {
				const pid = u.split(':')[2];
				state.library = state.library.filter((x) => x !== pid);
				state.unfollowed.push(pid);
			}
			return ok({});
		}
		if ((m = /^\/playlists\/([A-Za-z0-9]{22})\/followers$/.exec(p)) && method === 'DELETE') {
			state.library = state.library.filter((x) => x !== m[1]);
			state.unfollowed.push(m[1]);
			return ok({});
		}
		if ((m = /^\/playlists\/([A-Za-z0-9]{22})$/.exec(p))) {
			const pl = state.playlists[m[1]];
			if (!pl) return err(404, 'Not found');
			if (method === 'GET') return ok(plObj(pl));
			if (method === 'PUT') {
				if (!owned(pl)) return err(403, 'You cannot change this playlist');
				if (body?.name !== undefined) pl.name = body.name;
				if (body?.description !== undefined) pl.description = body.description;
				if (body?.public !== undefined) pl.public = body.public;
				return ok({});
			}
		}
		if ((m = /^\/playlists\/([A-Za-z0-9]{22})\/images$/.exec(p)) && method === 'PUT') return { status: 202, body: {} };
		if ((m = /^\/playlists\/([A-Za-z0-9]{22})\/(items|tracks)$/.exec(p))) {
			const pl = state.playlists[m[1]];
			if (!pl) return err(404, 'Not found');
			if (method === 'GET') {
				if (!owned(pl)) return err(403, 'Forbidden');
				const limit = Number(query.get('limit') ?? 100);
				const offset = Number(query.get('offset') ?? 0);
				const items = pl.items.slice(offset, offset + limit).map((u) => ({ added_at: '2026-01-01T00:00:00Z', item: track(u), track: track(u) }));
				return ok({ items, total: pl.items.length, next: offset + limit < pl.items.length ? 'next' : null });
			}
			if (!owned(pl)) return err(403, 'You cannot change this playlist');
			const uris = body?.uris ?? (query.get('uris') ? query.get('uris').split(',') : []);
			if (method === 'PUT') pl.items = [...uris];
			if (method === 'POST') {
				const pos = typeof body?.position === 'number' ? body.position : pl.items.length;
				pl.items.splice(pos, 0, ...uris);
			}
			if (method === 'DELETE') {
				const drop = new Set((body?.items ?? body?.tracks ?? []).map((x) => x.uri));
				pl.items = pl.items.filter((u) => !drop.has(u));
			}
			return ok({ snapshot_id: bump(pl) }, method === 'POST' ? 201 : 200);
		}
		if ((m = /^\/tracks\/([A-Za-z0-9]{22})$/.exec(p)) && method === 'GET') return ok(track(`spotify:track:${m[1]}`));
		// ── R7: artist albums + album tracks (Release radar, Python with the cron token) ──
		if ((m = /^\/artists\/([A-Za-z0-9]{22})\/albums$/.exec(p)) && method === 'GET') {
			const items = ((state.artistAlbums ?? {})[m[1]] ?? []).slice(0, Number(query.get('limit') ?? 20));
			return ok({ items, total: items.length, next: null, limit: items.length, offset: 0 });
		}
		if ((m = /^\/albums\/([A-Za-z0-9]{22})\/tracks$/.exec(p)) && method === 'GET') {
			const uris = (state.albumTracks ?? {})[m[1]] ?? [];
			return ok({ items: uris.map((u) => ({ uri: u, id: u.split(':')[2], name: `Track ${u.slice(-4)}` })), next: null, total: uris.length });
		}
		return { status: 501, body: { error: { status: 501, message: `E2E mock: unmocked ${method} ${p}` } }, unmocked: true };
	}

	// ── YouTube Data API v3 + SoundCloud oEmbed (R4) ──
	function youtubeApi(path, q) {
		const yt = state.youtube ?? { playlists: {}, videos: {} };
		if (!q.get('key')) return err(403, 'missing key');
		const name = path.split('/').at(-1);
		if (name === 'playlists') {
			const p = yt.playlists[q.get('id')];
			return ok({ items: p ? [{ id: q.get('id'), snippet: { title: p.title, channelTitle: p.channel, thumbnails: {} }, contentDetails: { itemCount: p.items.length } }] : [] });
		}
		if (name === 'playlistItems') {
			const p = yt.playlists[q.get('playlistId')];
			if (!p) return err(404, 'playlistNotFound');
			const start = Number(q.get('pageToken') ?? 0);
			const per = Number(q.get('maxResults') ?? 5);
			const slice = p.items.slice(start, start + per);
			return ok({ items: slice.map((videoId) => ({ contentDetails: { videoId } })), ...(start + per < p.items.length ? { nextPageToken: String(start + per) } : {}) });
		}
		if (name === 'videos') {
			const ids = (q.get('id') ?? '').split(',');
			return ok({
				items: ids
					.filter((i) => yt.videos[i])
					.map((i) => ({ id: i, snippet: { title: yt.videos[i].title, channelTitle: yt.videos[i].channel, thumbnails: {} }, contentDetails: { duration: yt.videos[i].duration ?? 'PT3M' }, status: { embeddable: yt.videos[i].embeddable !== false, privacyStatus: 'unlisted' } }))
			});
		}
		return err(404, 'unknown youtube endpoint');
	}
	function soundcloudOembed(q) {
		const u = q.get('url');
		const sc = (state.soundcloud ?? {})[u];
		if (!sc) return err(404, 'Not found');
		return ok({ version: 1, type: 'rich', title: sc.title, author_name: sc.author, thumbnail_url: null, html: `<iframe width="100%" height="400" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?visual=true&url=${encodeURIComponent(u)}"></iframe>` });
	}

	// ── R7: MusicBrainz (JSON) + Scantraxx monthly pages (HTML) ──
	function musicbrainzApi(path, q) {
		const mb = state.musicbrainz ?? { bySpotify: {}, releases: {} };
		if (state.musicbrainzDown) return err(503, 'MusicBrainz is down (E2E)');
		const name = path.split('/').at(-1);
		if (name === 'url') {
			const id = (q.get('resource') ?? '').split('/artist/')[1];
			const hit = mb.bySpotify[id];
			return hit ? ok({ resource: q.get('resource'), relations: [{ type: 'free streaming', artist: { id: hit.mbid, name: hit.name } }] }) : err(404, 'Not Found');
		}
		if (name === 'artist') return ok({ count: 0, offset: 0, artists: [] });
		if (name === 'release') {
			const arid = /arid:([\w-]+)/.exec(q.get('query') ?? '')?.[1];
			return ok({ count: 0, offset: 0, releases: mb.releases[arid] ?? [] });
		}
		return err(404, 'unknown musicbrainz endpoint');
	}
	function scantraxxPage(path) {
		const m = /\/news\/releases-scantraxx-([a-z]+-\d{4})$/.exec(path);
		const html = m && (state.scantraxx ?? {})[m[1]];
		return html ? { status: 200, body: html, html: true } : { status: 404, body: '<h1>Not found</h1>', html: true };
	}

	/**
	 * R8 Data health: read-only GitHub REST (repo, workflows, runs). `state.github` overrides the
	 * defaults per test: { status, pushedAt, private, states: {file: state}, runs: {file: [run]} }.
	 */
	function githubRead(path) {
		const gh = state.github ?? {};
		if (gh.status && gh.status !== 200) return err(gh.status, 'Bad credentials');
		const day = 86_400_000;
		const at = (d) => new Date(Date.now() - d * day).toISOString();
		const files = ['scheduled-ingest.yml', 'hub-jobs.yml', 'ingest-monitor.yml', 'keepalive.yml', 'ci.yml'];
		if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return ok({ pushed_at: gh.pushedAt ?? at(40), private: gh.private ?? false });
		if (/^\/repos\/[^/]+\/[^/]+\/actions\/workflows$/.test(path))
			return ok({ total_count: files.length, workflows: files.map((f, i) => ({ id: i + 1, path: `.github/workflows/${f}`, state: gh.states?.[f] ?? 'active' })) });
		const m = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([\w.-]+)\/runs$/.exec(path);
		if (m) {
			const def = m[1] === 'keepalive.yml'
				? [{ created_at: at(5), updated_at: at(5), conclusion: 'success', status: 'completed', event: 'schedule', html_url: 'https://github.com/e2e/runs/2' }]
				: [{ created_at: at(0.01), updated_at: at(0.01), conclusion: 'success', status: 'completed', event: 'schedule', html_url: 'https://github.com/e2e/runs/1' }];
			return ok({ total_count: 1, workflow_runs: gh.runs?.[m[1]] ?? def });
		}
		return err(404, 'E2E mock: unknown GitHub call');
	}

	/** One external request → mocked response. `who` = 'hub' | 'python'. */
	function handle({ method, url, body, who = 'hub', headers = {} }) {
		const u = new URL(url);
		const entry = { at: Date.now(), who, method, host: u.host, path: u.pathname, query: u.search, body, ua: headers['user-agent'] ?? null, headers };
		let res;
		if (u.host === 'accounts.spotify.com' && u.pathname === '/api/token') {
			const grant = typeof body === 'object' && body ? body.grant_type : null;
			res = ok({ access_token: `at-e2e-${calls.length}`, token_type: 'Bearer', expires_in: 3600, scope: HUB_SCOPES, ...(grant === 'authorization_code' ? { refresh_token: 'rt-e2e' } : {}) });
		} else if (u.host === 'api.spotify.com' || (who === 'python' && u.pathname.startsWith('/v1/'))) {
			res = spotifyApi(method, u.pathname, u.searchParams, body, who);
		} else if (u.host === 'www.googleapis.com' && u.pathname.startsWith('/youtube/v3/')) {
			res = youtubeApi(u.pathname, u.searchParams);
		} else if (u.host === 'soundcloud.com' && u.pathname === '/oembed') {
			res = soundcloudOembed(u.searchParams);
		} else if (u.host === 'musicbrainz.org' && u.pathname.startsWith('/ws/2/')) {
			res = musicbrainzApi(u.pathname, u.searchParams);
		} else if (u.host === 'scantraxx.com' && u.pathname.startsWith('/news/')) {
			res = scantraxxPage(u.pathname);
		} else if (u.host === 'api.github.com') {
			const m = /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/([\w.-]+)\/dispatches$/.exec(u.pathname);
			if (m && method === 'POST') {
				state.dispatches.push({ workflow: m[1], inputs: body?.inputs ?? {}, ref: body?.ref });
				for (const l of listeners.dispatch) l(m[1], body?.inputs ?? {});
				res = { status: 204 };
			} else if (method === 'GET') res = githubRead(u.pathname);
			else res = err(404, 'E2E mock: unknown GitHub call');
		} else {
			res = { status: 599, body: { error: 'E2E: blocked external host' }, blocked: true };
		}
		entry.status = res.status;
		if (res.unmocked) entry.unmocked = true;
		if (res.blocked) entry.blocked = true;
		calls.push(entry);
		return res;
	}

	return {
		handle,
		state: () => state,
		calls: () => calls,
		resetCalls: () => (calls = []),
		reset: () => {
			state = structuredClone(initial);
			calls = [];
		},
		merge: (patch) => {
			for (const [k, v] of Object.entries(patch)) state[k] = v;
		},
		onDispatch: (fn) => listeners.dispatch.push(fn)
	};
}
