<script lang="ts">
	import Eq from './Eq.svelte';
	import type { TrackRow } from '$lib/shared/daily-types';
	import { player } from '$lib/stores/player.svelte';
	import { fmtInt, fmtTime } from '$lib/shared/format';
	/** Track list. Tap a row = play from this list's context at that track. */
	let { rows, contextUri, onplayat }: { rows: TrackRow[]; contextUri: string | null; onplayat: (i: number) => void } = $props();
	const playingUri = $derived(contextUri && player.view.context?.uri === contextUri ? player.view.item?.uri : null);
</script>

<div class="rows">
	{#each rows as r, i (r.uri + i)}
		<button class="row" class:playing={playingUri === r.uri} onclick={() => onplayat(i)}>
			<span class="idx">{#if playingUri === r.uri}<Eq paused={!player.view.isPlaying} />{:else}{i + 1}{/if}</span>
			<span class="grow">
				<span class="rt ell" style="display:block" title={r.name ?? r.uri}>{r.name ?? 'Unknown track'}</span>
				<span class="rm ell" style="display:block">{r.artist ?? ''}</span>
			</span>
			<span class="plays">{fmtInt(r.plays)} plays</span>
			<span class="dur">{r.durationMs ? fmtTime(r.durationMs) : ''}</span>
		</button>
	{/each}
</div>
