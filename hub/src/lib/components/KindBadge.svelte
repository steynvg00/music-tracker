<script lang="ts">
	import Icon from './Icon.svelte';
	import { kindLabel, type ManagedKind } from '$lib/shared/managed';
	/** Managed playlists get a kind badge; everything else a lock: read + play only (hard rule). */
	let { kind, isOwned, isCollab = false }: { kind: ManagedKind | null; isOwned: boolean; isCollab?: boolean } = $props();
</script>

{#if kind}
	<span class="badge">{kindLabel(kind)}</span>
{:else if isOwned || isCollab}
	<span class="lock" title="Read & play only: Rotor never edits it"><Icon name="lock" size={12} /> Read & play</span>
{:else}
	<span class="lock" title="You follow this playlist: play only"><Icon name="lock" size={12} /> Play only</span>
{/if}
