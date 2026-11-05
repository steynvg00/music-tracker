<script lang="ts">
	import type { PlayerArtist } from '$lib/shared/player-types';
	import { artistHref, artistIdFromUri } from '$lib/shared/stats';
	/** Artist names as doors to their Rotor artist page (03-ux-ia §1.6). Names verbatim. */
	let { artists, onnavigate }: { artists: PlayerArtist[]; onnavigate?: () => void } = $props();
</script>

{#each artists as a, i (a.name + i)}{@const href = artistHref(artistIdFromUri(a.uri))}{i ? ', ' : ''}{#if href}<a {href} onclick={onnavigate}>{a.name}</a>{:else}{a.name}{/if}{/each}

<style>
	a {
		color: inherit;
	}
	a:hover {
		text-decoration: underline;
	}
</style>
