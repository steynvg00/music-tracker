<script lang="ts">
	import '@fontsource-variable/manrope';
	import '../app.css';
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
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
			nav.cancel();
			location.href = nav.to.url.href;
		}
	});

	onMount(() => {
		(window as unknown as { __rotorBoot?: { booted: () => void } }).__rotorBoot?.booted();
		const sw = navigator.serviceWorker;
		if (!sw) return;
		const hadController = !!sw.controller;
		const onChange = () => {
			if (hadController) reloadNext = true;
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
