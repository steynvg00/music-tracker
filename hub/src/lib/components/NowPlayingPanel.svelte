<script lang="ts">
	import Art from './Art.svelte';
	import Attribution from './Attribution.svelte';
	import HistoryCard from './HistoryCard.svelte';
	import Icon from './Icon.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { trackHref } from '$lib/shared/stats';
	import ArtistLinks from './ArtistLinks.svelte';
	/** Laptop right panel (≥ 1180 px): now playing + "your history with this track". */
	const v = $derived(player.view);
</script>

<aside class="rpanel" aria-label="Now playing">
	<h4>
		<span class="ell">{player.contextInfo?.name ?? (v.context ? 'Playing from Spotify' : 'Now playing')}</span>
		<button class="ibtn" aria-label="Close panel" onclick={() => (ui.rightPanel = false)}><Icon name="close" size={18} /></button>
	</h4>
	{#if v.item}
		<div class="big"><Art src={v.item.imageUrlLarge ?? v.item.imageUrl} size={300} alt={v.item.albumName ?? ''} /></div>
		<h2 title={v.item.name}>{#if trackHref(v.item.uri)}<a class="tl" href={trackHref(v.item.uri)}>{v.item.name}</a>{:else}{v.item.name}{/if}</h2>
		<div class="cap"><ArtistLinks artists={v.item.artists} /></div>
		<div style="margin-top:10px"><Attribution uri={v.item.uri} /></div>
		<HistoryCard stats={player.trackStats} surface="panel" />
	{:else}
		<p class="cap muted">Nothing playing. Start something from Today's pick or pick a device.</p>
	{/if}
</aside>

<style>
	.rpanel {
		display: none;
	}
	@media (min-width: 1180px) {
		.rpanel {
			display: flex;
			flex-direction: column;
			grid-row: 1;
			grid-column: 3;
			background: var(--surface-1);
			border-radius: 10px;
			overflow-y: auto;
			padding: 16px;
			min-height: 0;
		}
	}
	h4 {
		margin: 0 0 12px;
		font-size: 15px;
		font-weight: 800;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.big :global(.art) {
		width: 100% !important;
		height: auto !important;
		aspect-ratio: 1;
	}
	h2 {
		margin: 14px 0 2px;
		font-size: 22px;
		line-height: 26px;
		font-weight: 800;
		letter-spacing: -0.02em;
	}
</style>
