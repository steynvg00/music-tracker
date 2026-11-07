<script lang="ts">
	import Art from '../Art.svelte';
	import Eq from '../Eq.svelte';
	import Icon from '../Icon.svelte';
	import KindBadge from '../KindBadge.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ttlLabel } from '$lib/shared/custom';
	import type { Entry, LibView } from '$lib/shared/library';

	/**
	 * One Library entry (v0.91): a playlist, Liked Songs or a Rotor folder, as a list row or a grid
	 * tile. Manage mode: the whole row toggles selection instead of opening. `handle` shows the drag
	 * handle (pinned list / custom order); on a phone the row itself is long-pressed to drag.
	 */
	let {
		e,
		view = 'list',
		manage = false,
		selected = false,
		handle = false,
		likedUri,
		ontoggle
	}: { e: Entry; view?: LibView; manage?: boolean; selected?: boolean; handle?: boolean; likedUri: string; ontoggle?: (key: string) => void } = $props();

	const name = $derived(e.type === 'playlist' ? e.row.name : e.type === 'folder' ? e.folder.name : 'Liked Songs');
	const href = $derived(e.type === 'playlist' ? `/playlist/${e.row.id}` : e.type === 'folder' ? `/library?folder=${e.folder.id}` : null);
	const playing = $derived(e.type === 'playlist' ? player.view.context?.uri === e.row.uri : e.type === 'liked' ? player.view.context?.uri === likedUri : false);
	function playLiked() {
		if (player.view.context?.uri === likedUri) void player.togglePlay();
		else void player.playContext(likedUri, 'Liked Songs');
	}
</script>

{#snippet art(size: number)}
	{#if e.type === 'playlist'}
		<Art src={e.row.imageUrl} {size} />
	{:else if e.type === 'folder'}
		<span class="art s fold" style="width:{size}px;height:{size}px"><Icon name="folder" size={Math.round(size * 0.45)} /></span>
	{:else}
		<span class="art s heart" style="width:{size}px;height:{size}px"><Icon name="play" size={Math.round(size * 0.4)} /></span>
	{/if}
{/snippet}

{#snippet meta()}
	{#if e.type === 'playlist'}
		<KindBadge kind={e.row.kind} isOwned={e.row.isOwned} isCollab={e.row.isCollab} />
		{#if e.row.kind === 'custom'}<span class="badge {e.row.expiresAt ? 'warn' : ''}">{ttlLabel(e.row.expiresAt)}</span>{/if}
		<span class="ell">{e.row.trackCount !== null ? `${e.row.trackCount} tracks` : 'Playlist'}{e.row.isOwned ? '' : e.row.ownerName ? ` · ${e.row.ownerName}` : ''}</span>
	{:else if e.type === 'folder'}
		<span class="ell">Folder · {e.count} playlist{e.count === 1 ? '' : 's'}{e.children ? ` · ${e.children} folder${e.children === 1 ? '' : 's'}` : ''}</span>
	{:else}
		<span class="ell">{manage ? 'Your liked songs' : 'Tap to play · read & play'}</span>
	{/if}
{/snippet}

{#snippet body()}
	{#if view === 'grid'}
		<span class="tile-art">{@render art(132)}</span>
		<span class="tn ell" title={name}>{#if e.pinned}<span class="pin" aria-label="Pinned"><Icon name="pin" size={12} /></span>{/if}{name}</span>
	{:else}
		{@render art(56)}
		<span class="grow">
			<span class="n ell" title={name}>{#if e.pinned}<span class="pin" aria-label="Pinned"><Icon name="pin" size={12} /></span>{/if}{name}</span>
			<span class="m">{@render meta()}</span>
		</span>
		{#if playing}<Eq paused={!player.view.isPlaying} />{/if}
	{/if}
{/snippet}

<div class="entry {view}" class:sel={selected} class:playing data-key={e.key} data-type={e.type} data-testid="entry">
	{#if manage}
		<button class="main" role="checkbox" aria-checked={selected} aria-label="Select {name}" onclick={() => ontoggle?.(e.key)}>
			<span class="cb" aria-hidden="true">{#if selected}<Icon name="check" size={14} />{/if}</span>
			{@render body()}
		</button>
	{:else if href}
		<a class="main" {href} title={name}>{@render body()}</a>
	{:else}
		<button class="main" onclick={playLiked} aria-label="Play Liked Songs">{@render body()}</button>
	{/if}
	{#if handle && view === 'list'}
		<button class="handle" data-sort-handle aria-label="Reorder {name} (drag, or arrow keys)" title="Drag to reorder"><Icon name="drag" size={18} /></button>
	{/if}
</div>

<style>
	.entry {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: 6px;
		touch-action: pan-y;
		-webkit-touch-callout: none;
		user-select: none;
	}
	.entry.list {
		margin: 0 -8px;
	}
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 4px 8px;
		text-align: left;
		color: inherit;
		border-radius: 6px;
	}
	.list .main:hover {
		background: var(--surface-2);
	}
	.grid .main {
		flex-direction: column;
		align-items: stretch;
		gap: 6px;
		padding: 6px;
		min-height: 0;
	}
	.tile-art :global(.art) {
		width: 100% !important;
		height: auto !important;
		aspect-ratio: 1;
	}
	.tile-art :global(img) {
		width: 100%;
		height: 100%;
	}
	.tn {
		font-size: 13px;
		font-weight: 650;
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
	.pin {
		color: var(--accent);
		margin-right: 4px;
		display: inline-flex;
		vertical-align: -1px;
	}
	.fold {
		display: grid;
		place-items: center;
		background: var(--surface-3);
		color: var(--text-2);
	}
	.heart {
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(135deg, #6d4bd8, #9fd7e8);
	}
	.cb {
		flex: none;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		border: 2px solid var(--text-3);
		display: grid;
		place-items: center;
		color: var(--on-accent);
	}
	.sel .cb {
		background: var(--accent);
		border-color: var(--accent);
	}
	.sel .main {
		background: var(--accent-subtle);
	}
	.grid .cb {
		position: absolute;
		top: 12px;
		left: 12px;
		z-index: 1;
		background: var(--surface-2);
	}
	.handle {
		flex: none;
		width: 40px;
		height: 48px;
		display: grid;
		place-items: center;
		color: var(--text-3);
		cursor: grab;
		touch-action: none;
	}
	:global(.sorting) .handle {
		cursor: grabbing;
	}
	:global(.dragging) {
		z-index: 3;
		background: var(--surface-3);
		box-shadow: var(--shadow-pop);
		opacity: 0.95;
	}
	:global(.drop-before) {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	:global(.drop-after) {
		box-shadow: inset 0 -2px 0 var(--accent);
	}
</style>
