<script lang="ts">
	import { onMount } from 'svelte';
	import { navigating, page } from '$app/state';
	import RouteSkeleton from '$lib/components/RouteSkeleton.svelte';
	import { SKELETON_DELAY_MS, skeletonFor, type SkeletonKind } from '$lib/shared/skeleton';
	import Banner from '$lib/components/Banner.svelte';
	import DevicePicker from '$lib/components/DevicePicker.svelte';
	import FullPlayer from '$lib/components/FullPlayer.svelte';
	import MiniPlayer from '$lib/components/MiniPlayer.svelte';
	import NowPlayingPanel from '$lib/components/NowPlayingPanel.svelte';
	import PlayerBar from '$lib/components/PlayerBar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import TabBar from '$lib/components/TabBar.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import CustomPlaylistSheet from '$lib/components/custom-playlist-sheet/CustomPlaylistSheet.svelte';
	import { apiGet, apiPost } from '$lib/player/api-client';
	import type { DailyDeck } from '$lib/shared/daily-types';
	import { daily } from '$lib/stores/daily.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { goto } from '$app/navigation';
	import { swrPrefetch } from '$lib/swr.svelte';
	import { tick } from 'svelte';
	import { library } from '$lib/stores/library.svelte';
	import { RESUME_KEY, parseSaved, resumable, resumeTarget } from '$lib/resume';

	let { data, children } = $props();
	const hub = $derived(data.connections.hub);
	const cron = $derived(data.connections.cron);
	const reconnectHref = $derived(`/auth/login?client=hub&reconnect=1&next=${encodeURIComponent(page.url.pathname)}`);

	onMount(() => {
		player.start();
		// Sidebar's "Today's pick" on pages that don't load the deck themselves.
		if (!daily.deck) void apiGet<DailyDeck>('/api/daily').then((d) => !daily.deck && daily.set(d)).catch(() => undefined);
		// Keep the playlist mirror fresh (server skips when < 1 h old). Once per session.
		try {
			if (!sessionStorage.getItem('rotor.mirror')) {
				sessionStorage.setItem('rotor.mirror', '1');
				void apiPost('/api/playlists/sync').catch(() => undefined);
			}
		} catch {
			/* private mode */
		}
		// v0.92: reopen the installed app where you left it (page + scroll position). The page may still be
		// growing (data, progressive rows): keep trying for up to ~1.5 s until the position is reachable.
		// The app scrolls its <main id="main">, not the window.
		const scroller = () => document.getElementById('main');
		const restoreScroll = (y: number, tries = 90) => {
			const m = scroller();
			if (!m) return;
			m.scrollTop = y;
			if (Math.abs(m.scrollTop - y) > 4 && tries > 0) requestAnimationFrame(() => restoreScroll(y, tries - 1));
		};
		const save = () => {
			const path = location.pathname + location.search;
			if (!resumable(path)) return;
			try {
				localStorage.setItem(RESUME_KEY, JSON.stringify({ path, scrollY: Math.round(document.getElementById('main')?.scrollTop ?? 0), at: Date.now() }));
			} catch {
				/* private mode */
			}
		};
		const onHide = () => document.visibilityState === 'hidden' && save();
		document.addEventListener('visibilitychange', onHide);
		addEventListener('pagehide', save);
		let saved = null;
		try {
			saved = parseSaved(localStorage.getItem(RESUME_KEY));
		} catch {
			/* private mode */
		}
		const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
		const target = resumeTarget({ standalone, path: location.pathname, saved, now: Date.now(), firstLoad: !nav || nav.type === 'navigate' });
		if (target) {
			void goto(target.path, { replaceState: true, noScroll: true }).then(async () => {
				await tick();
				restoreScroll(target.scrollY);
			});
		} else if (saved && saved.path === location.pathname + location.search && standalone) {
			void tick().then(() => restoreScroll(saved!.scrollY));
		}
		// v0.92: warm the likely next tabs once the app is idle (their data lands in the SWR cache).
		const idle = (cb: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
		idle(() => {
			void library.load().catch(() => undefined);
			// Data only (the SWR cache), never preloadData(): a preloaded ROUTE would let the next click run
			// client-side on this build even after a newer one took over (HF-7's full-load rule).
			swrPrefetch(['/api/stats/overview', '/api/home', '/api/playlists', '/api/library'].filter((p) => !p.endsWith(location.pathname)));
		});
		return () => {
			player.stop();
			document.removeEventListener('visibilitychange', onHide);
			removeEventListener('pagehide', save);
		};
	});

	// R8: a skeleton of the target page while its data loads (client navigation to another route).
	let skeleton = $state<SkeletonKind | null>(null);
	$effect(() => {
		const to = navigating.to;
		const kind = to && to.route.id !== navigating.from?.route.id ? skeletonFor(to.url.pathname) : null;
		if (!kind) {
			skeleton = null;
			return;
		}
		const t = setTimeout(() => (skeleton = kind), SKELETON_DELAY_MS);
		return () => clearTimeout(t);
	});

	function keys(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select, [contenteditable], [role="slider"]')) return;
		if (e.key === ' ' && !t.closest('button, a')) {
			e.preventDefault();
			void player.togglePlay();
		} else if (e.shiftKey && e.key === 'ArrowRight') {
			e.preventDefault();
			void player.next();
		} else if (e.shiftKey && e.key === 'ArrowLeft') {
			e.preventDefault();
			void player.previous();
		} else if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey) {
			void player.openDevices();
		}
	}
</script>

<svelte:window onkeydown={keys} />

<div class="app" class:rp={ui.rightPanel}>
	<Sidebar current={daily.current} />
	<main class="main" id="main">
		{#if player.reauth || hub.lastError === 'invalid_grant' || !hub.connected}
			<div class="bwrap">
				<Banner kind="danger"><span>Spotify needs you to sign in again.</span><a class="btn sec" href={reconnectHref} data-sveltekit-reload>Reconnect Spotify</a></Banner>
			</div>
		{:else if hub.health !== 'ok' && hub.daysLeft !== null}
			<div class="bwrap">
				<Banner kind={hub.health === 'danger' ? 'danger' : 'warning'}><span>Rotor's Spotify sign-in expires in {hub.daysLeft} days.</span><a class="btn sec" href={reconnectHref} data-sveltekit-reload>Reconnect</a></Banner>
			</div>
		{/if}
		{#if cron.connected && cron.health !== 'ok'}
			<div class="bwrap">
				<Banner kind={cron.health === 'danger' ? 'danger' : 'warning'}>
					<span>{cron.lastError === 'invalid_grant' ? 'The crons’ Spotify token stopped working.' : `The crons’ Spotify token expires in ${cron.daysLeft} days.`}</span>
					<a class="btn sec" href="/auth/login?client=cron" data-sveltekit-reload>Reconnect crons</a>
				</Banner>
			</div>
		{/if}
		{#if player.quotaLimited}
			<div class="bwrap"><Banner kind="warning"><span>Spotify is rate-limiting Rotor. Updates slowed down.</span></Banner></div>
		{/if}
		{#if skeleton}<RouteSkeleton kind={skeleton} />{:else}{@render children()}{/if}
	</main>
	{#if ui.rightPanel}<NowPlayingPanel />{/if}
	<PlayerBar />
</div>

<MiniPlayer />
<TabBar />
<FullPlayer />
<DevicePicker />
<CustomPlaylistSheet />
<Toasts />
<div class="sr" aria-live="polite">{ui.announcement}</div>

<style>
	.app {
		position: fixed;
		inset: 0;
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: 1fr;
	}
	.main {
		grid-row: 1;
		overflow-y: auto;
		overflow-x: hidden;
		position: relative;
		padding-bottom: calc(var(--tabbar-h) + var(--mini-h) + 24px + var(--safe-bottom));
	}
	.bwrap {
		padding: calc(var(--safe-top) + 8px) var(--gutter) 0;
	}
	.bwrap + .bwrap {
		padding-top: 0;
	}
	@media (min-width: 768px) {
		.app {
			grid-template-columns: 280px minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr) 80px;
			gap: 8px;
			padding: 8px 8px 0;
		}
		.main {
			grid-column: 2;
			background: var(--surface-1);
			border-radius: 10px;
			padding-bottom: 24px;
		}
		.bwrap {
			padding-top: 12px;
		}
	}
	@media (min-width: 1180px) {
		.app.rp {
			grid-template-columns: 280px minmax(0, 1fr) 340px;
		}
	}
</style>
