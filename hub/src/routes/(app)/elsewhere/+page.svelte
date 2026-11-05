<script lang="ts">
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import Collections from '$lib/components/elsewhere/Collections.svelte';
	import type { Source } from '$lib/shared/elsewhere';
	/** Elsewhere: YouTube + SoundCloud, a separate room from Spotify (03-ux-ia.md §3). */
	const source = $derived<Source>(page.url.searchParams.get('source') === 'soundcloud' ? 'soundcloud' : 'youtube');
</script>

<svelte:head><title>Rotor · Elsewhere</title></svelte:head>

<div class="view">
	<Header title="Elsewhere" />
	<nav class="seg" aria-label="Source">
		<a href="?source=youtube" aria-current={source === 'youtube' ? 'page' : undefined} class:on={source === 'youtube'}>YouTube</a>
		<a href="?source=soundcloud" aria-current={source === 'soundcloud' ? 'page' : undefined} class:on={source === 'soundcloud'}>SoundCloud</a>
	</nav>
	{#key source}<Collections {source} />{/key}
</div>

<style>
	.seg {
		display: inline-flex;
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 3px;
		margin: 4px 0 8px;
	}
	.seg a {
		padding: 7px 16px;
		border-radius: var(--r-pill);
		color: var(--text-2);
		font-weight: 600;
		min-height: 36px;
		display: inline-flex;
		align-items: center;
	}
	.seg a.on {
		background: var(--accent);
		color: var(--on-accent);
	}
</style>
