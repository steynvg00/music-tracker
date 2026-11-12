<script lang="ts">
	import '@fontsource-variable/manrope';
	import '../app.css';
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { swrHydrated } from '$lib/swr.svelte';
	import { updated } from '$app/state';

	let { children } = $props();

	/**
	 * v0.83.1 — deploys never strand an open or installed PWA:
	 *   - tell static/boot-guard.js the app started (it removes its "couldn't start" panel);
	 *   - check for a new service worker whenever the app comes back to the foreground (an iPhone
	 *     PWA can stay suspended for days) and every 30 minutes while open;
	 *   - once a NEW worker takes control, or SvelteKit sees a new build (updated), the next
	 *     navigation is a full page load, so this tab never mixes old code with the new build's
	 *     chunks. Mid-session nothing reloads by itself (the player keeps running).
	 */
	let reloadNext = false;

	beforeNavigate((nav) => {
		if (!nav.to || nav.willUnload || nav.to.url.origin !== location.origin) return;
		if (reloadNext || updated.current) {
			document.body.dataset.sveltekitPreloadData = 'off';
			nav.cancel();
			location.href = nav.to.url.href;
		}
	});

	onMount(() => {
		swrHydrated(); // v0.92: from now on the SWR cache may answer page loads
		(window as unknown as { __rotorBoot?: { booted: () => void } }).__rotorBoot?.booted();
		const sw = navigator.serviceWorker;
		if (!sw) return;
		const hadController = !!sw.controller;
		const onChange = () => {
			if (!hadController) return;
			reloadNext = true;
			// v0.92: with hover/touchstart preloading, a hover would load the OLD build's chunks for the next
			// page before the click; once a new build has taken over, stop preloading so the click is the
			// full page load beforeNavigate asks for.
			document.body.dataset.sveltekitPreloadData = 'off';
			document.body.dataset.sveltekitPreloadCode = 'off';
		};
		sw.addEventListener('controllerchange', onChange);
		let last = 0;
		const check = () => {
			if (document.visibilityState !== 'visible' || Date.now() - last < 60_000) return;
			last = Date.now();
			void sw.getRegistration().then((r) => r?.update()).catch(() => undefined);
			void updated.check().catch(() => undefined);
		};
		document.addEventListener('visibilitychange', check);
		const timer = setInterval(check, 30 * 60_000);
		return () => {
			sw.removeEventListener('controllerchange', onChange);
			document.removeEventListener('visibilitychange', check);
			clearInterval(timer);
		};
	});
</script>

{@render children()}
