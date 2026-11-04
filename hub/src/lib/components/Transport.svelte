<script lang="ts">
	import Icon from './Icon.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	/** shuffle · prev · play/pause · next · repeat. Disallowed controls render disabled (Design Guidelines). */
	let { size = 'bar' }: { size?: 'bar' | 'full' } = $props();
	const v = $derived(player.view);
	const dis = $derived(v.disallows);
	const no = $derived(!v.active);
</script>

<div class="ctrl {size}">
	<button class="ibtn" class:on={v.shuffle} aria-pressed={v.shuffle} aria-label="Shuffle" disabled={no || dis.toggling_shuffle} title={dis.toggling_shuffle ? 'Not allowed on this device' : 'Shuffle'} onclick={() => player.toggleShuffle()}>
		<Icon name="shuffle" size={size === 'full' ? 24 : 18} />
	</button>
	<button class="ibtn" aria-label="Previous" disabled={no || dis.skipping_prev} onclick={() => player.previous()}>
		<Icon name="prev" size={size === 'full' ? 30 : 18} />
	</button>
	{#key ui.shakePlay}
		<button class="play {size} {ui.shakePlay ? 'shake' : ''}" aria-label={v.isPlaying ? 'Pause' : 'Play'} disabled={v.isPlaying ? dis.pausing : dis.resuming} onclick={() => player.togglePlay()}>
			<Icon name={v.isPlaying ? 'pause' : 'play'} size={size === 'full' ? 28 : 18} />
		</button>
	{/key}
	<button class="ibtn" aria-label="Next" disabled={no || dis.skipping_next} onclick={() => player.next()}>
		<Icon name="next" size={size === 'full' ? 30 : 18} />
	</button>
	<button
		class="ibtn"
		class:on={v.repeat !== 'off'}
		aria-label="Repeat: {v.repeat}"
		disabled={no || dis.toggling_repeat_context || dis.toggling_repeat_track}
		onclick={() => player.cycleRepeat()}
	>
		<Icon name={v.repeat === 'track' ? 'repeat1' : 'repeat'} size={size === 'full' ? 24 : 18} />
	</button>
</div>

<style>
	.ctrl {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ctrl.full {
		justify-content: space-between;
		width: 100%;
	}
	.play.bar {
		width: 40px;
		height: 40px;
	}
	.play.full {
		width: 64px;
		height: 64px;
	}
</style>
