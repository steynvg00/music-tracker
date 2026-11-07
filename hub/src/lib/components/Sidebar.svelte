<script lang="ts">
	import { page } from '$app/state';
	import Icon, { type IconName } from './Icon.svelte';
	import RotorMark from './RotorMark.svelte';
	import Art from './Art.svelte';
	import RotorCover from './RotorCover.svelte';
	import LibraryRowItem from './LibraryRowItem.svelte';
	import { customSheet } from './custom-playlist-sheet/store.svelte';
	import { library } from '$lib/stores/library.svelte';
	import { CHIP_LABEL, filterRows, sortRows, type Chip } from '$lib/shared/library';
	import type { DailyCandidate } from '$lib/shared/daily-types';
	import { onMount } from 'svelte';
	/** Laptop sidebar: navigation, Today's pick, and the library (chips + compact rows). */
	let { current }: { current: DailyCandidate | null } = $props();
	const SIDEBAR_CHIPS: Chip[] = ['managed', 'snapshots', 'custom', 'yours', 'followed'];
	let chip = $state<Chip | null>(null);
	const rows = $derived(sortRows(filterRows(library.rows, new Set(chip ? [chip] : [])), 'az'));
	onMount(() => {
		if (window.matchMedia('(min-width: 768px)').matches) void library.load();
	});
	const links: { href: string; icon: IconName; label: string; match: RegExp }[] = [
		{ href: '/home', icon: 'home', label: 'Home', match: /^\/(home)?$/ },
		{ href: '/search', icon: 'search', label: 'Search', match: /^\/search/ },
		{ href: '/stats', icon: 'stats', label: 'Stats', match: /^\/stats/ },
		{ href: '/library', icon: 'lib', label: 'Library', match: /^\/library/ },
		{ href: '/elsewhere', icon: 'devices', label: 'Elsewhere', match: /^\/elsewhere/ },
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
		<div class="hdr">
			<a href="/library"><b>Library</b></a>
			<span class="hdr-acts">
				<a class="cap" href="/rules">Rules</a>
				<button class="ibtn" aria-label="New custom playlist" onclick={() => customSheet.openCreate()}><Icon name="plus" size={18} /></button>
			</span>
		</div>
		<div class="chips" role="group" aria-label="Library filter">
			{#each SIDEBAR_CHIPS as c (c)}
				<button class="chip" class:on={chip === c} aria-pressed={chip === c} onclick={() => (chip = chip === c ? null : c)}>{CHIP_LABEL[c]}</button>
			{/each}
		</div>
		<a class="sbrow" class:on={page.url.pathname.startsWith('/daily')} href="/daily">
			{#if current?.kind === 'generated'}
				<RotorCover title={current.title} recipe={current.recipe} size={48} />
			{:else}
				<Art src={current?.playlist?.imageUrl} size={48} />
			{/if}
			<span class="grow"><span class="n ell">Today's pick</span><span class="m ell"><span class="badge acc">Daily</span> {current?.title ?? 'Not mixed yet'}</span></span>
		</a>
		{#each rows as r (r.id)}<LibraryRowItem {r} compact />{/each}
		{#if library.loaded && !rows.length}<p class="cap muted pad">Nothing here yet. The playlist mirror fills this in.</p>{/if}
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
	.hdr-acts {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.chips {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scrollbar-width: none;
		padding: 0 4px 8px;
	}
	.chip {
		height: 28px;
		padding: 0 10px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		font-size: 12px;
		font-weight: 650;
		white-space: nowrap;
		border: 1px solid transparent;
		flex: none;
	}
	.chip.on {
		background: var(--accent-subtle);
		border-color: var(--accent);
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
