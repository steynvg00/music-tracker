<script lang="ts">
	import { page } from '$app/state';
	import Icon, { type IconName } from './Icon.svelte';
	import RotorMark from './RotorMark.svelte';
	import Art from './Art.svelte';
	import RotorCover from './RotorCover.svelte';
	import type { DailyCandidate } from '$lib/shared/daily-types';
	/** Laptop sidebar. R1: navigation + Today's pick; the full library lands in R2. */
	let { current }: { current: DailyCandidate | null } = $props();
	const links: { href: string; icon: IconName; label: string; match: RegExp }[] = [
		{ href: '/home', icon: 'home', label: 'Home', match: /^\/(home)?$/ },
		{ href: '/search', icon: 'search', label: 'Search', match: /^\/search/ },
		{ href: '/stats', icon: 'stats', label: 'Stats', match: /^\/stats/ },
		{ href: '/library', icon: 'lib', label: 'Library', match: /^\/library/ },
		{ href: '/settings', icon: 'gear', label: 'Settings', match: /^\/settings/ }
	];
</script>

<aside class="sidebar" aria-label="Navigation">
	<div class="top">
		<a href="/home" class="brand" aria-label="Rotor home"><span style="color:var(--accent)"><RotorMark /></span>rotor</a>
		{#each links as l (l.href)}
			<a class="navlink" class:on={l.match.test(page.url.pathname)} href={l.href}><Icon name={l.icon} /> {l.label}</a>
		{/each}
	</div>
	<div class="lib">
		<div class="hdr"><b>Library</b><span class="badge">R2</span></div>
		<a class="sbrow" class:on={page.url.pathname.startsWith('/daily')} href="/daily">
			{#if current?.kind === 'generated'}
				<RotorCover title={current.title} recipe={current.recipe} size={48} />
			{:else}
				<Art src={current?.playlist?.imageUrl} size={48} />
			{/if}
			<span class="grow"><span class="n ell">Today's pick</span><span class="m ell"><span class="badge acc">Daily</span> {current?.title ?? 'Not mixed yet'}</span></span>
		</a>
		<p class="cap muted pad">Your playlists, filters and custom playlists arrive with the next release.</p>
	</div>
</aside>

<style>
	.sidebar {
		display: none;
	}
	@media (min-width: 768px) {
		.sidebar {
			display: flex;
			flex-direction: column;
			grid-row: 1;
			grid-column: 1;
			background: var(--surface-1);
			border-radius: 10px;
			overflow: hidden;
			min-height: 0;
		}
	}
	.top {
		padding: 16px 16px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 800;
		font-size: 20px;
		letter-spacing: -0.03em;
		padding: 4px 8px 12px;
	}
	.navlink {
		display: flex;
		align-items: center;
		gap: 14px;
		height: 40px;
		padding: 0 8px;
		border-radius: 6px;
		color: var(--text-2);
		font-weight: 700;
	}
	.navlink:hover,
	.navlink.on {
		color: var(--text-1);
	}
	.navlink.on {
		background: var(--surface-2);
	}
	.lib {
		flex: 1;
		min-height: 0;
		border-top: 1px solid var(--border);
		margin-top: 8px;
		padding: 0 8px;
		overflow-y: auto;
	}
	.hdr {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 8px 10px;
	}
	.hdr b {
		font-size: 15px;
	}
	.sbrow {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 6px 8px;
		border-radius: 6px;
		min-height: 56px;
	}
	.sbrow:hover {
		background: var(--surface-2);
	}
	.sbrow.on {
		background: var(--surface-3);
	}
	.grow {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.n {
		font-weight: 650;
		font-size: 14px;
	}
	.m {
		font-size: 12px;
		color: var(--text-3);
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.pad {
		padding: 8px;
	}
</style>
