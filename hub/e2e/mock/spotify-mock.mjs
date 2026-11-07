/**
 * E2E mock of every external service Rotor talks to (Spotify Web API + Accounts, GitHub
 * Actions dispatch; R4 adds YouTube Data API + SoundCloud oEmbed; R7 adds MusicBrainz + the Scantraxx
 * monthly release pages and Spotify artist albums). One in-memory state,
 * one call log. Used two ways:
 *   - in the hub's Node process, through preload.mjs (globalThis.fetch is wrapped);
 *   - over HTTP on 127.0.0.1:<E2E_MOCK_PORT>/v1/… for the Python job runner (spotipy prefix).
 * Nothing here ever reaches the network.
 */
import { randomBytes } from 'node:crypto';
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

	/**
	 * Time passes (R5): progress advances in real time; at the end of a track Spotify moves to the
	 * next one in the list; after the last one it stops, or with state.autoplay it carries on with
	 * state.autoplayUri (device Autoplay, F3).
	 */
	function tick() {
		const pb = state.playback;
		const now = Date.now();
		if (!pb) return;
		if (!pb.is_playing) {
			pb.since = now;
			return;
		}
		let prog = (pb.progress_ms ?? 0) + (now - (pb.since ?? now));
		pb.since = now;
		const list = pb.list ?? contextItems(pb.context_uri);
		for (let guard = 0; guard < 500; guard++) {
			const dur = track(pb.item_uri).duration_ms;
			if (prog < dur) break;
			prog -= dur;
			if (list.length && (pb.index ?? 0) < list.length - 1) {
				pb.index = (pb.index ?? 0) + 1;
				pb.item_uri = list[pb.index];
			} else if (state.autoplay && state.autoplayUri && pb.item_uri !== state.autoplayUri) {
				pb.item_uri = state.autoplayUri;
				pb.list = [state.autoplayUri];
				pb.index = 0;
				pb.context_uri = null;
			} else {
				pb.is_playing = false;
				prog = 0;
				break;
			}
		}
		pb.progress_ms = prog;
	}

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

	function spotifyApi(method, path, query, body) {
		const p = path.replace(/^\/v1/, '').replace(/\/+$/, '') || '/';
		tick();
		let m;
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
				repeat: prev?.repeat ?? 'off',
				since: Date.now()
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

	/** One external request → mocked response. `who` = 'hub' | 'python'. */
	function handle({ method, url, body, who = 'hub', headers = {} }) {
		const u = new URL(url);
		const entry = { at: Date.now(), who, method, host: u.host, path: u.pathname, query: u.search, body, ua: headers['user-agent'] ?? null, headers };
		let res;
		if (u.host === 'accounts.spotify.com' && u.pathname === '/api/token') {
			const grant = typeof body === 'object' && body ? body.grant_type : null;
			res = ok({ access_token: `at-e2e-${calls.length}`, token_type: 'Bearer', expires_in: 3600, scope: HUB_SCOPES, ...(grant === 'authorization_code' ? { refresh_token: 'rt-e2e' } : {}) });
		} else if (u.host === 'api.spotify.com' || (who === 'python' && u.pathname.startsWith('/v1/'))) {
			res = spotifyApi(method, u.pathname, u.searchParams, body);
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
			} else res = err(404, 'E2E mock: unknown GitHub call');
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
