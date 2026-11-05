/**
 * Shared E2E fixtures: external requests from the browser are intercepted (the Spotify SDK gets a
 * local stub, everything else is aborted and recorded), page errors fail the test, and helpers
 * talk to the mock control server and the throwaway database.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 55433}`;
const DB = process.env.E2E_DB ?? '';
const PSQL = join(process.env.PG_BIN ?? '/usr/local/opt/postgresql@16/bin', 'psql');

/** Never point these at anything but the throwaway DB. */
if (DB && !/@(127\.0\.0\.1|localhost):/.test(DB)) throw new Error('E2E_DB must be local');

export function sql(query: string): string {
	return execFileSync(PSQL, ['-At', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', query], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }).trim();
}
export const sqlNum = (q: string) => Number(sql(q));

export interface MockCall {
	who: 'hub' | 'python';
	method: string;
	host: string;
	path: string;
	query: string;
	body: unknown;
	status: number;
	unmocked?: boolean;
	blocked?: boolean;
	at: number;
	/** R7: request User-Agent / headers as the mock received them (Python requests). */
	ua?: string | null;
	headers?: Record<string, string>;
}

/**
 * fetch to the mock control server with one retry: a long synchronous step in a test (a Python
 * daily run via execFileSync) can outlive Node's 5 s keep-alive, and the next request then hits the
 * closed socket (ECONNRESET). Retrying once on a fresh connection is safe for these idempotent calls.
 */
async function ctlFetch(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch {
		// Both retries combined (R7 + R5): a short pause, then a fresh connection.
		await new Promise((r) => setTimeout(r, 150));
		return fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Connection: 'close' } });
	}
}

/** fetch to the mock control server by path, retried once (see ctlFetch). */
async function ctl(path: string, init?: RequestInit): Promise<Response> {
	return ctlFetch(`${MOCK}${path}`, init);
}

export const mock = {
	async calls(): Promise<MockCall[]> {
		return (await ctl('/__mock/calls')).json();
	},
	async resetCalls() {
		await ctl('/__mock/reset-calls', { method: 'POST' });
	},
	async state(): Promise<Record<string, any>> {
		return (await ctl('/__mock/state')).json();
	},
	async set(patch: Record<string, unknown>) {
		await ctl('/__mock/state', { method: 'POST', body: JSON.stringify(patch) });
	},
	async pushes(): Promise<{ endpoint: string; data: { kind: string; title: string; body: string; url: string } }[]> {
		return (await ctl('/__mock/pushes')).json();
	},
	async fixture(): Promise<Record<string, any>> {
		return (await this.state()).fixture;
	},
	/** Spotify writes (non-GET) the hub/python made since the last reset. */
	async writes(): Promise<MockCall[]> {
		return (await this.calls()).filter((c) => c.host === 'api.spotify.com' && c.method !== 'GET');
	}
};

/** Stub for https://sdk.scdn.co/spotify-player.js: a Player that never produces audio. */
const SDK_STUB = `window.Spotify = { Player: class {
  constructor(o) { this.o = o; this.l = {}; }
  addListener(e, f) { this.l[e] = f; return true; } removeListener() { return true; }
  connect() { setTimeout(() => { this.l.ready && this.l.ready({ device_id: 'dev-laptop-sdk' }); this.watch(); }, 50); return Promise.resolve(true); }
  // Like the real SDK: state events for this device (read from the mocked Spotify via Rotor's own API).
  watch() { if (this.t) return; this.t = setInterval(async () => { try {
    const r = await fetch('/api/player/state', { headers: { Accept: 'application/json' } }); if (!r.ok) return;
    const s = (await r.json()).snapshot; if (!s || !s.device || s.device.id !== 'dev-laptop-sdk' || !s.item) return;
    this.l.player_state_changed && this.l.player_state_changed({ paused: !s.isPlaying, position: s.progressMs, duration: s.item.durationMs, timestamp: Date.now(),
      track_window: { current_track: { uri: s.item.uri, type: 'track', name: s.item.name, duration_ms: s.item.durationMs, artists: s.item.artists, album: { name: s.item.albumName || '', images: [] } } },
      context: s.context ? { uri: s.context.uri } : null, disallows: {} });
  } catch (e) {} }, 600); }
  cmd(p, b) { return fetch('/api/player/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: 'dev-laptop-sdk', ...(b || {}) }) }).then(() => undefined); }
  disconnect() { clearInterval(this.t); } activateElement() { return Promise.resolve(); } getCurrentState() { return Promise.resolve(null); }
  pause() { return this.cmd('pause'); } resume() { return this.cmd('play'); } togglePlay() { return this.cmd('pause'); }
  nextTrack() { return this.cmd('next'); } previousTrack() { return this.cmd('previous'); } seek(ms) { return this.cmd('seek', { position_ms: ms }); }
  setVolume() { return Promise.resolve(); } } };
setTimeout(() => window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady(), 0);`;

/**
 * Stub of https://www.youtube.com/iframe_api (R4): a VISIBLE stand-in player in the element the
 * app gives it, with the real API's surface. window.__yt lets tests fire ENDED / errors and see
 * what the app asked for. Videos listed in window.__ytRefuse answer error 150 (not embeddable).
 */
const YT_STUB = `(() => {
  const log = (window.__ytLog = window.__ytLog || []);
  window.__ytRefuse = window.__ytRefuse || [];
  class Player {
    constructor(el, o) {
      this.o = o; this.id = null;
      const box = document.createElement('div');
      box.dataset.ytStub = '1';
      box.style.cssText = 'width:100%;height:100%;background:#111;color:#eee;display:grid;place-items:center;font:14px system-ui';
      box.textContent = 'YouTube player (E2E stub)';
      el.replaceWith(box); this.box = box;
      window.__yt = this;
      setTimeout(() => o.events && o.events.onReady && o.events.onReady({ target: this }), 20);
    }
    _state(s) { this.o.events.onStateChange && this.o.events.onStateChange({ data: s, target: this }); }
    loadVideoById(id) { this.id = id; log.push('load:' + id); this.box.textContent = 'YouTube ▶ ' + id;
      window.__ytBlocked = window.__ytBlocked || {};
      // window.__ytBlockAutoplay: the first autoplaying load of each video is refused (no user gesture).
      if (window.__ytBlockAutoplay && !window.__ytBlocked[id]) { window.__ytBlocked[id] = true; setTimeout(() => this.o.events.onAutoplayBlocked && this.o.events.onAutoplayBlocked({ target: this }), 30); return; }
      setTimeout(() => window.__ytRefuse.includes(id) ? this.o.events.onError({ data: 150, target: this }) : this._state(1), 30); }
    cueVideoById(id) { this.id = id; log.push('cue:' + id); }
    playVideo() { log.push('play'); this._state(1); }
    pauseVideo() { log.push('pause'); this._state(2); }
    stopVideo() { log.push('stop'); }
    destroy() { log.push('destroy'); }
    ended() { this._state(0); }
  }
  window.YT = { Player };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();`;

/**
 * Stub of https://w.soundcloud.com/player/api.js: SC.Widget over the (stubbed) widget iframe.
 * window.__sc.sounds sets what the widget reports (policy 'SNIP' = Go+ preview).
 */
const SC_STUB = `(() => {
  const log = (window.__scLog = window.__scLog || []);
  const Events = { READY: 'ready', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish', ERROR: 'error' };
  function Widget(iframe) {
    const h = {}; const st = (window.__sc = window.__sc || { sounds: [{ title: 'SC one' }, { title: 'SC two' }], index: 0 });
    const fire = (e) => (h[e] || []).forEach((f) => f());
    st.fire = fire;
    setTimeout(() => fire(Events.READY), 20);
    return {
      bind: (e, f) => { (h[e] = h[e] || []).push(f); },
      play: () => { log.push('play:' + st.index); fire(Events.PLAY); },
      pause: () => { log.push('pause'); fire(Events.PAUSE); },
      next: () => { st.index = Math.min(st.index + 1, st.sounds.length - 1); log.push('next:' + st.index); fire(Events.PLAY); },
      prev: () => { st.index = Math.max(st.index - 1, 0); log.push('prev:' + st.index); fire(Events.PLAY); },
      skip: (i) => { st.index = i; fire(Events.PLAY); },
      getCurrentSound: (cb) => cb(st.sounds[st.index] || null),
      getCurrentSoundIndex: (cb) => cb(st.index),
      getSounds: (cb) => cb(st.sounds),
      load: (url, o) => { log.push('load:' + url); st.sounds = [{ title: url.split('/').pop() }]; st.index = 0; setTimeout(() => o && o.auto_play && fire(Events.PLAY), 30); }
    };
  }
  Widget.Events = Events;
  window.SC = { Widget };
})();`;

export async function guardExternal(page: Page, blocked: string[]) {
	await page.context().route('**/*', async (route) => {
		const u = new URL(route.request().url());
		if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
		if (u.hostname === 'sdk.scdn.co') return route.fulfill({ status: 200, contentType: 'text/javascript', body: SDK_STUB });
		if (u.hostname === 'www.youtube.com' && u.pathname === '/iframe_api') return route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
		if (u.hostname === 'w.soundcloud.com' && u.pathname === '/player/api.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: SC_STUB });
		if (u.hostname === 'w.soundcloud.com' && u.pathname === '/player/') {
			return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="margin:0;background:#f50;color:#fff;font:14px system-ui;display:grid;place-items:center;height:100vh">SoundCloud widget (E2E stub)</body>' });
		}
		blocked.push(u.href);
		return route.abort();
	});
}

type Fixtures = { errors: string[]; blocked: string[] };

export const test = base.extend<Fixtures>({
	blocked: async ({}, use) => {
		await use([]);
	},
	errors: [
		async ({ page, blocked }, use) => {
			const errors: string[] = [];
			await guardExternal(page, blocked);
			page.on('pageerror', (e) => {
				errors.push(`pageerror: ${e.message}`);
				console.log(`[pageerror] ${page.url()}\n${e.stack}`);
			});
			// Service-worker console (fallback reasons etc.) goes to the run log.
			page.context().on('console', (m) => m.text().includes('[rotor-sw]') && console.log(`[sw-console] ${m.text()}`));
			await use(errors);
			expect(errors, 'no uncaught page errors').toEqual([]);
		},
		{ auto: true }
	]
});

export { expect };

/** Wait until a hub job reaches a terminal state (the mocked dispatch runs real Python). */
export async function waitForJob(where: string, timeoutMs = 90_000): Promise<string> {
	const t = Date.now();
	for (;;) {
		const s = sql(`SELECT status FROM hub_jobs WHERE ${where} ORDER BY requested_at DESC LIMIT 1`);
		if (s === 'done' || s === 'failed') return s;
		if (Date.now() - t > timeoutMs) return s || 'missing';
		await new Promise((r) => setTimeout(r, 500));
	}
}

/** Sign in through the real /auth routes; Spotify's authorize page is intercepted and redirects back. */
export async function signIn(page: Page, user: string | null = null) {
	await mock.set({ loginUser: user });
	// Answer /auth/login ourselves: take the Location the hub would send (Spotify's authorize URL),
	// and send the browser straight back to /auth/callback with a fake code. The browser never
	// navigates to accounts.spotify.com (and the DNS wall in playwright.config.ts would stop it anyway).
	await page.context().route('**/auth/login**', async (route) => {
		const res = await route.fetch({ maxRedirects: 0 });
		const loc = res.headers()['location'] ?? '';
		if (!loc.startsWith('https://accounts.spotify.com/authorize')) return route.fulfill({ response: res });
		const u = new URL(loc);
		const back = new URL(u.searchParams.get('redirect_uri')!);
		back.searchParams.set('code', 'e2e-code');
		back.searchParams.set('state', u.searchParams.get('state')!);
		const headers = { ...res.headers(), location: back.href };
		await route.fulfill({ status: 302, headers });
	});
	await page.goto('/login');
	await page.getByRole('link', { name: 'Sign in with Spotify' }).click();
}


