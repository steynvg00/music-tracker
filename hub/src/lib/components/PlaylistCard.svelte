<script lang="ts">
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';
	import KindBadge from './KindBadge.svelte';
	import type { PlaylistCard } from '$lib/shared/daily-types';
	import { player } from '$lib/stores/player.svelte';
	/** Shelf card. R1 has no playlist detail yet, so tap = play (with the device flow). */
	let { p }: { p: PlaylistCard } = $props();
	const playing = $derived(player.view.context?.uri === p.uri && player.view.isPlaying);
	function go() {
		if (player.view.context?.uri === p.uri) void player.togglePlay();
		else void player.playContext(p.uri, p.name);
	}
</script>

<button class="card" onclick={go} title={p.name} aria-label="{playing ? 'Pause' : 'Play'} {p.name}">
	{#if p.virtual === 'liked'}
		<span class="art l liked"><Icon name="play" size={36} /></span>
	{:else}
		<Art src={p.imageUrl} size={140} />
	{/if}
	<span class="fab" aria-hidden="true"><Icon name={playing ? 'pause' : 'play'} size={18} /></span>
	<span class="ct">{p.name}</span>
	<span class="cs">{#if p.subtitle}{p.subtitle} · {/if}<KindBadge kind={p.kind} isOwned={p.isOwned} isCollab={p.isCollab} /></span>
</button>

<style>
	.card {
		flex: none;
		width: 140px;
		scroll-snap-align: start;
		text-align: left;
		border-radius: var(--r-card);
		position: relative;
		display: flex;
		flex-direction: column;
	}
	.liked {
		width: 140px;
		height: 140px;
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(135deg, #6d4bd8, #9fd7e8);
		border-radius: var(--r-art-l);
	}
	.ct {
		font-size: 14px;
		font-weight: 700;
		margin-top: 8px;
		line-height: 18px;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.cs {
		font-size: 12px;
		line-height: 16px;
		color: var(--text-3);
		margin-top: 2px;
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
	}
	.fab {
		display: none;
	}
	@media (min-width: 768px) {
		.card {
			width: auto;
			padding: 12px;
			transition: background var(--t-micro);
		}
		.card:hover {
			background: var(--surface-3);
		}
		.card :global(.art) {
			width: 100% !important;
			height: auto !important;
			aspect-ratio: 1;
		}
		.fab {
			display: grid;
			position: absolute;
			right: 20px;
			bottom: 68px;
			width: 44px;
			height: 44px;
			border-radius: 50%;
			background: var(--accent);
			color: var(--on-accent);
			place-items: center;
			opacity: 0;
			transform: translateY(8px);
			transition: all var(--t-std) var(--ease-std);
			box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
		}
		.card:hover .fab,
		.card:focus-visible .fab {
			opacity: 1;
			transform: none;
		}
	}
</style>
