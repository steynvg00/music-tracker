<script lang="ts">
	import Art from './Art.svelte';
	import Eq from './Eq.svelte';
	import KindBadge from './KindBadge.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ttlLabel } from '$lib/shared/custom';
	import type { LibraryRow } from '$lib/shared/library';
	/** Library row (mobile 56 px art) / sidebar row (laptop 48 px). Tap → playlist detail. */
	let { r, compact = false }: { r: LibraryRow; compact?: boolean } = $props();
	const playing = $derived(player.view.context?.uri === r.uri);
</script>

<a class="lrow" class:compact class:playing href="/playlist/{r.id}" title={r.name}>
	<Art src={r.imageUrl} size={compact ? 48 : 56} />
	<span class="grow">
		<span class="n ell">{r.name}</span>
		<span class="m">
			<KindBadge kind={r.kind} isOwned={r.isOwned} isCollab={r.isCollab} />
			{#if r.kind === 'custom'}<span class="badge {r.expiresAt ? 'warn' : ''}">{ttlLabel(r.expiresAt)}</span>{/if}
			<span class="ell">{r.trackCount !== null ? `${r.trackCount} tracks` : 'Playlist'}{r.isOwned ? '' : r.ownerName ? ` · ${r.ownerName}` : ''}</span>
		</span>
	</span>
	{#if playing}<Eq paused={!player.view.isPlaying} />{/if}
</a>

<style>
	.lrow {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 4px 8px;
		margin: 0 -8px;
		border-radius: 6px;
	}
	.lrow.compact {
		min-height: 56px;
		gap: 10px;
		margin: 0;
	}
	.lrow:hover {
		background: var(--surface-2);
	}
	.grow {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.n {
		font-weight: 650;
		font-size: 15px;
	}
	.compact .n {
		font-size: 14px;
	}
	.playing .n {
		color: var(--accent-hover);
	}
	.m {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-3);
		min-width: 0;
	}
</style>
