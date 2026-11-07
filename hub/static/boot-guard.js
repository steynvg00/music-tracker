/*
 * Rotor boot guard (v0.83.1). A classic script loaded from app.html BEFORE the app's modules, so it
 * still runs when those modules can't load. Its one job: an installed PWA must never sit on a
 * black screen after a deploy.
 *
 * Failure modes it covers:
 *   - A worker from an older build serves an old page whose /_app/ chunks no longer exist on the
 *     server (each Vercel deploy only serves its own assets) → the module import fails.
 *   - Any other failure that stops the app from starting (hydration crash, a hung load).
 *
 * What it does:
 *   - An /_app/ script, stylesheet or module import fails before the app has started → RESET once:
 *     unregister every service worker, delete every cache, reload from the network.
 *   - It happens again right after a reset → a visible panel ("Rotor couldn't start") with
 *     Reload and Reset buttons, never an empty dark page.
 *   - The app's entry modules haven't even loaded after BOOT_MS → "Rotor is taking long to
 *     start". As a small bar at the bottom when the page already shows server-rendered content
 *     (it is usable to read; v0.83.2), as the full panel only when the page is empty.
 *   - Two signals from the app:
 *       shellLoaded()  hooks.client.ts init(): the entry modules loaded and ran, so the shell is
 *                      fine. No timeout bar/panel after this — slow DATA (a cold Vercel function,
 *                      a first service-worker install hogging the network, a slow /api/home) is
 *                      not a broken shell, and hydration waits for that data (v0.83.2 fix: in
 *                      v0.83.1 the 15 s timer ran until hydration and covered a working page).
 *       booted()       root +layout.svelte onMount: fully started; removes any bar/panel.
 *   - Buttons anywhere with data-rotor-reload / data-rotor-reset (error pages) use the same
 *     actions, so error pages work without inline scripts (CSP: script-src 'self').
 */
(function () {
	'use strict';
	var BOOT_MS = 20000;
	var KEY = 'rotor-boot-reset';
	var PARAM = 'rotor-reset';
	var started = false; // fully started (hydrated)
	var shell = false; // entry modules loaded (hooks.client.ts init)
	var panel = null;

	function now() {
		return Date.now();
	}
	function lastReset() {
		var t = 0;
		try {
			t = Number(sessionStorage.getItem(KEY) || 0);
		} catch (e) {}
		// Fallback when sessionStorage is unavailable: the marker in the URL.
		var m = /[?&]rotor-reset=(\d+)/.exec(location.search);
		return Math.max(t, m ? Number(m[1]) : 0);
	}
	function cleanUrl(extra) {
		var u = new URL(location.href);
		u.searchParams.delete(PARAM);
		if (extra) u.searchParams.set(PARAM, String(extra));
		return u.pathname + u.search + u.hash;
	}

	function reset(reason) {
		var t = now();
		try {
			sessionStorage.setItem(KEY, String(t));
		} catch (e) {}
		var jobs = [];
		try {
			if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
				jobs.push(
					navigator.serviceWorker.getRegistrations().then(function (rs) {
						return Promise.all(rs.map(function (r) { return r.unregister(); }));
					})
				);
			}
			if (window.caches && caches.keys) {
				jobs.push(
					caches.keys().then(function (ks) {
						return Promise.all(ks.map(function (k) { return caches.delete(k); }));
					})
				);
			}
		} catch (e) {}
		var done = function () {
			location.replace(cleanUrl(t));
		};
		Promise.all(jobs).then(done, done);
		setTimeout(done, 3000); // never wait forever on a broken worker
		window.__rotorBoot.lastReason = reason;
	}

	/** Server-rendered content on screen (the app is readable even before it is interactive). */
	function hasContent() {
		var b = document.body;
		return !!b && (b.innerText || '').replace(/\s+/g, '').length > 40;
	}

	function showPanel(reason, blocking) {
		if (blocking === undefined) blocking = true;
		if (started || panel || !document.body) {
			if (!document.body) document.addEventListener('DOMContentLoaded', function () { showPanel(reason, blocking); });
			return;
		}
		panel = document.createElement('div');
		panel.id = 'rotor-boot-panel';
		panel.setAttribute('role', blocking ? 'alert' : 'status');
		panel.setAttribute('data-reason', reason);
		panel.setAttribute('data-mode', blocking ? 'panel' : 'bar');
		panel.style.cssText = blocking
			? 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
				'gap:14px;padding:24px;background:#0B0B0E;color:#F5F5F7;font:16px/1.4 system-ui,-apple-system,sans-serif;text-align:center'
			: 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147483647;display:flex;' +
				'flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;padding:12px 14px;border-radius:14px;' +
				'background:#25252D;color:#F5F5F7;font:14px/1.35 system-ui,-apple-system,sans-serif;text-align:center;' +
				'box-shadow:0 8px 24px rgba(0,0,0,.5)';
		var h = document.createElement('h1');
		h.textContent = reason === 'timeout' ? 'Rotor is taking long to start' : reason === 'offline' ? 'You’re offline' : 'Rotor couldn’t start';
		h.style.cssText = blocking ? 'font-size:22px;margin:0' : 'font-size:15px;margin:0';
		var p = document.createElement('p');
		p.textContent =
			reason === 'timeout'
				? 'Your connection may be slow. Reload, or reset Rotor on this device if it keeps happening.'
				: reason === 'offline'
					? 'Rotor needs the network to load this page. Reload once you’re back online.'
					: 'Probably a new version was deployed while an old one was cached on this device.';
		p.style.cssText = 'margin:0;color:#B4B4BF;max-width:34ch' + (blocking ? '' : ';display:none');
		var row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center';
		row.appendChild(button('Reload', 'data-rotor-reload', true));
		row.appendChild(button('Reset Rotor on this device', 'data-rotor-reset', false));
		panel.appendChild(h);
		panel.appendChild(p);
		panel.appendChild(row);
		document.body.appendChild(panel);
	}
	function button(label, attr, primary) {
		var b = document.createElement('button');
		b.type = 'button';
		b.textContent = label;
		b.setAttribute(attr, '');
		b.style.cssText =
			'min-height:44px;padding:0 18px;border-radius:999px;border:0;font:600 15px system-ui,-apple-system,sans-serif;cursor:pointer;' +
			(primary ? 'background:#9D6BFF;color:#0B0B0E' : 'background:#25252D;color:#F5F5F7');
		return b;
	}

	function hidePanel() {
		if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
		panel = null;
	}

	function fail(reason) {
		if (started) return;
		if (panel && panel.getAttribute('data-reason') === 'timeout') hidePanel(); // a real failure replaces the slow-start bar
		// Offline: resetting would throw away the offline copy. Show the panel; Reload works once back online.
		if (navigator.onLine === false) return showPanel('offline');
		// One automatic reset per minute; after that, show the panel instead of looping.
		if (now() - lastReset() > 60000) reset(reason);
		else showPanel(reason);
	}

	window.__rotorBoot = {
		shellLoaded: function () {
			shell = true;
			if (panel && panel.getAttribute('data-reason') === 'timeout') hidePanel();
		},
		booted: function () {
			started = true;
			shell = true;
			hidePanel();
			if (/[?&]rotor-reset=/.test(location.search)) {
				try {
					history.replaceState(history.state, '', cleanUrl(0));
				} catch (e) {}
			}
		},
		isBooted: function () {
			return started;
		},
		isShellLoaded: function () {
			return shell;
		},
		reset: reset,
		lastReason: null
	};

	// 1. A script / stylesheet / modulepreload of the app failed to load (404 after a deploy, etc.).
	window.addEventListener(
		'error',
		function (e) {
			var t = e.target;
			if (!t || t === window || !t.tagName) return;
			var url = t.src || t.href || '';
			if ((t.tagName === 'SCRIPT' || t.tagName === 'LINK') && /\/_app\//.test(url)) fail('asset');
		},
		true
	);
	// 2. The app's entry import() rejected (Chrome: "Failed to fetch dynamically imported module",
	//    Safari: "Importing a module script failed", Firefox: "error loading dynamically imported module").
	window.addEventListener('unhandledrejection', function (e) {
		var m = String((e.reason && e.reason.message) || e.reason || '');
		if (/dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(m)) fail('import');
	});
	window.addEventListener('vite:preloadError', function () {
		fail('preload');
	});
	// 3. Nothing failed loudly, but the entry modules never even ran: tell the user (no automatic
	//    reset: a slow network isn't a broken cache). Never once the shell is up (see shellLoaded).
	setTimeout(function () {
		if (!started && !shell) showPanel('timeout', !hasContent());
	}, BOOT_MS);
	// Buttons on the panel and on the error pages.
	document.addEventListener('click', function (e) {
		var el = e.target && e.target.closest ? e.target.closest('[data-rotor-reload],[data-rotor-reset]') : null;
		if (!el) return;
		e.preventDefault();
		if (el.hasAttribute('data-rotor-reset')) reset('manual');
		else location.replace(cleanUrl(0));
	});
})();
