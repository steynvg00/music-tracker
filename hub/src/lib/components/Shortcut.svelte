<script lang="ts">
	import Art from './Art.svelte';
	import Eq from './Eq.svelte';
	import Icon from './Icon.svelte';
	import type { PlaylistCard } from '$lib/shared/daily-types';
	import { player } from '$lib/stores/player.svelte';
	let { p }: { p: PlaylistCard } = $props();
	const isCtx = $derived(player.view.context?.uri === p.uri);
</script>

<button class="sc" title={p.name} onclick={() => (isCtx ? player.togglePlay() : player.playContext(p.uri, p.name))}>
	{#if p.virtual === 'liked'}
		<span class="art s liked"><Icon name="play" size={20} /></span>
	{:else}
		<Art src={p.imageUrl} size={56} />
	{/if}
	<span class="n">{p.name}</span>
	{#if isCtx}<Eq paused={!player.view.isPlaying} />{/if}
</button>

<style>
	.sc {
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--surface-2);
		border-radius: 6px;
		overflow: hidden;
		height: 56px;
		text-align: left;
		padding-right: 8px;
		transition: background var(--t-micro);
	}
	.sc:hover {
		background: var(--surface-3);
	}
	.sc :global(.art) {
		border-radius: var(--r-art-s) 0 0 var(--r-art-s);
	}
	.liked {
		width: 56px;
		height: 56px;
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(135deg, #6d4bd8, #9fd7e8);
	}
	.n {
		font-size: 13px;
		line-height: 16px;
		font-weight: 700;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		flex: 1;
	}
</style>
