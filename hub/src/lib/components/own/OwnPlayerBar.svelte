<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { ownPlayer } from '$lib/stores/own-player.svelte';
	import { fmtClock } from '$lib/shared/own';

	/** v0.94: Rotor's own player (your uploads only), on top of every page while something is loaded (lock screen: Media Session). */
	const it = $derived(ownPlayer.current);
	const href = $derived(it ? (it.kind === 'set' ? `/sets/${it.id}` : `/own/${it.id}`) : '#');
</script>

{#if it}
	<div class="opb" role="region" aria-label="Rotor player (your own uploads)" data-testid="own-player" data-refreshes={ownPlayer.refreshes} data-playing={ownPlayer.playing}>
		<a class="meta" {href}>
			{#if it.cover}<img src={it.cover} alt="" width="40" height="40" />{:else}<span class="ph"><Icon name="note" size={18} /></span>{/if}
			<span class="t"><b class="ell">{it.title}</b><span class="cap muted ell">{it.artist} · {it.kind === 'set' ? 'Set' : 'Own track'} · Rotor player</span></span>
		</a>
		<div class="ctl">
			{#if ownPlayer.queue.length > 1}<button class="ibtn" aria-label="Previous" onclick={() => ownPlayer.previous()}><Icon name="prev" size={18} /></button>{/if}
			<button class="ibtn" aria-label="Back 15 seconds" onclick={() => ownPlayer.skip(-15_000)}>−15</button>
			<button class="ibtn play" aria-label={ownPlayer.playing ? 'Pause' : 'Play'} onclick={() => ownPlayer.toggle()} data-testid="own-toggle"><Icon name={ownPlayer.playing ? 'pause' : 'play'} size={20} /></button>
			<button class="ibtn" aria-label="Forward 15 seconds" onclick={() => ownPlayer.skip(15_000)}>+15</button>
			{#if ownPlayer.queue.length > 1}<button class="ibtn" aria-label="Next" onclick={() => ownPlayer.next()}><Icon name="next" size={18} /></button>{/if}
			<button class="ibtn" aria-label="Close the Rotor player" onclick={() => ownPlayer.stop()}><Icon name="close" size={18} /></button>
		</div>
		<label class="scrub">
			<span class="sr">Position</span>
			<span class="cap tab-num" data-testid="own-pos">{fmtClock(ownPlayer.positionMs)}</span>
			<input type="range" min="0" max={Math.max(1, ownPlayer.durationMs)} step="1000" value={ownPlayer.positionMs} oninput={(e) => ownPlayer.seek(Number((e.target as HTMLInputElement).value))} />
			<span class="cap tab-num">{fmtClock(ownPlayer.durationMs)}</span>
		</label>
		{#if ownPlayer.error}<p class="cap err" role="alert">{ownPlayer.error}</p>{/if}
	</div>
{/if}

<style>
	.opb {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 4px 12px;
		align-items: center;
		padding: calc(var(--safe-top, 0px) + 8px) var(--gutter) 8px;
		margin: 0 calc(-1 * var(--gutter)) 8px;
		background: var(--surface-1);
		border-bottom: 1px solid var(--border);
	}
	.meta {
		display: flex;
		gap: 10px;
		align-items: center;
		min-width: 0;
		color: var(--text-1);
	}
	.meta img,
	.ph {
		width: 40px;
		height: 40px;
		border-radius: 4px;
		object-fit: cover;
		background: var(--surface-3);
		display: grid;
		place-items: center;
		flex: none;
	}
	.t {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.ctl {
		display: flex;
		align-items: center;
		gap: 2px;
		font-size: 12px;
		font-weight: 700;
	}
	.scrub {
		grid-column: 1 / -1;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.scrub input {
		flex: 1;
		accent-color: var(--accent);
	}
	.err {
		grid-column: 1 / -1;
		color: var(--danger, #e5534b);
		margin: 0;
	}
</style>
