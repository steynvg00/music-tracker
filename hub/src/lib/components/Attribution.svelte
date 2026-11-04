<script lang="ts">
	import Icon from './Icon.svelte';
	import { openInSpotify } from '$lib/shared/format';
	/**
	 * Attribution slot (05-design.md §7.2): a neutral TEXT label "Spotify" + an
	 * "Open in Spotify" link. No Spotify logo or assets (your rule; open question 2).
	 */
	let { uri }: { uri: string | null | undefined } = $props();
	const href = $derived(openInSpotify(uri));
</script>

<span class="attrib">
	<span class="slot"><Icon name="disc" size={12} /> Spotify</span>
	{#if href}<a {href} target="_blank" rel="noopener noreferrer">Open in Spotify</a>{/if}
</span>

<style>
	.attrib {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--text-2);
	}
	.slot {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 22px;
		padding: 0 8px;
		border-radius: var(--r-pill);
		border: 1px solid var(--surface-4);
		font-weight: 700;
		color: var(--text-1);
	}
	a {
		text-decoration: underline;
		text-underline-offset: 2px;
		white-space: nowrap;
	}
</style>
