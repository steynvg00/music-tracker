<script lang="ts">
	import Header from './Header.svelte';
	import { greeting } from '$lib/shared/format';
	import type { SkeletonKind } from '$lib/shared/skeleton';
	/**
	 * Skeletons while a page's data loads during client navigation (R8, 05-design.md §7): the real
	 * header in its real place, then grey blocks shaped like the page (hero, tiles, shelves, rows).
	 * Shown by the (app) layout only after 120 ms, so fast navigations never flash.
	 */
	let { kind, title = '' }: { kind: SkeletonKind; title?: string } = $props();
	const TITLE: Record<SkeletonKind, string> = { home: '', stats: 'Stats', library: 'Library', wrapped: 'Rotor Wrapped', radar: 'Release radar', list: '' };
	const heading = $derived(kind === 'home' ? greeting() : title || TITLE[kind]);
</script>

{#snippet rows(n: number, art = 56)}
	{#each Array.from({ length: n }, (_, i) => i) as i (i)}
		<div class="row"><div class="skel" style="width:{art}px;height:{art}px;flex:none"></div><div class="lines"><div class="skel l1"></div><div class="skel l2"></div></div></div>
	{/each}
{/snippet}

<div class="view" data-testid="skeleton" data-kind={kind} aria-busy="true" aria-label="Loading">
	{#if kind === 'wrapped'}
		<div class="story skel"></div>
	{:else}
		<Header title={heading} />
		{#if kind === 'home'}
			<div class="skel strip"></div>
			<div class="hero">
				<div class="top"><div class="skel hart"></div><div class="lines"><div class="skel" style="height:14px;width:40%"></div><div class="skel" style="height:24px;width:80%"></div><div class="skel" style="height:14px;width:90%"></div></div></div>
				<div class="acts"><div class="skel pill" style="width:96px"></div><div class="skel pill" style="width:110px"></div></div>
			</div>
			<div class="skel h2"></div>
			<div class="tiles">{#each [1, 2, 3, 4] as i (i)}<div class="skel tile"></div>{/each}</div>
			<div class="skel h2"></div>
			<div class="shelf">{#each [1, 2, 3, 4, 5] as i (i)}<div class="card"><div class="skel cart"></div><div class="skel l1"></div></div>{/each}</div>
		{:else if kind === 'stats'}
			<div class="pillph" aria-hidden="true"><div class="skel pill" style="width:96px"></div><div class="skel pill" style="width:72px"></div><div class="skel pill" style="width:84px"></div></div>
			<div class="tiles">{#each [1, 2, 3, 4] as i (i)}<div class="skel tile"></div>{/each}</div>
			<div class="skel h2"></div>
			<div class="skel chart"></div>
			<div class="skel h2"></div>
			{@render rows(5, 40)}
		{:else if kind === 'library'}
			<div class="pillph" aria-hidden="true"><div class="skel pill" style="width:72px"></div><div class="skel pill" style="width:84px"></div><div class="skel pill" style="width:104px"></div></div>
			{@render rows(8)}
		{:else if kind === 'radar'}
			<div class="skel pill" style="width:240px;margin-top:8px"></div>
			<div class="skel h2"></div>
			{@render rows(8, 48)}
		{:else}
			{@render rows(8, 40)}
		{/if}
	{/if}
</div>

<style>
	.strip {
		height: 60px;
		margin-top: 4px;
		border-radius: var(--r-card);
	}
	.hero {
		margin-top: 16px;
		padding: 16px;
		border-radius: 12px;
		background: var(--surface-2);
	}
	.hero .skel {
		background: var(--surface-3, var(--surface-4));
	}
	.top {
		display: flex;
		gap: 14px;
		margin-top: 22px;
	}
	.hart {
		width: 120px;
		height: 120px;
		border-radius: 8px;
		flex: none;
	}
	.lines {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}
	.acts {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}
	.pill {
		height: 40px;
		border-radius: 999px;
	}
	.h2 {
		height: 20px;
		width: 140px;
		margin: 28px 0 12px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		margin-top: 16px;
	}
	.tile {
		height: 112px;
		border-radius: 12px;
	}
	.shelf {
		display: flex;
		gap: 12px;
		overflow: hidden;
	}
	.card {
		flex: none;
		width: 140px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.cart {
		width: 140px;
		height: 140px;
		border-radius: 8px;
	}
	.chart {
		height: 160px;
		border-radius: 8px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 4px 8px;
	}
	.l1 {
		height: 14px;
		width: 55%;
	}
	.l2 {
		height: 12px;
		width: 35%;
	}
	.story {
		position: fixed;
		inset: 0;
		border-radius: 0;
		z-index: 5;
	}
	@media (min-width: 768px) {
		.hart {
			width: 200px;
			height: 200px;
		}
		.hero {
			padding: 24px;
		}
		.tiles {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	/* Same box as PillBar (v0.91): 44 px high, 2px 0 10px margin. */
	.pillph {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 44px;
		margin: 2px 0 10px;
	}
	.pillph .pill {
		height: 32px;
		border-radius: var(--r-pill);
	}
</style>
