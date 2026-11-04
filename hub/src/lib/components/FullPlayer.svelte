<script lang="ts">
	import Art from './Art.svelte';
	import Attribution from './Attribution.svelte';
	import HistoryCard from './HistoryCard.svelte';
	import Icon from './Icon.svelte';
	import Scrubber from './Scrubber.svelte';
	import Transport from './Transport.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { artistLine, deviceIcon } from '$lib/shared/format';
	/** Mobile full-screen player sheet. Swipe down or the chevron closes it. */
	const v = $derived(player.view);
	const open = $derived(ui.sheet === 'player');
	let startY = 0;
	let dy = $state(0);
	let el: HTMLElement | undefined = $state();

	$effect(() => {
		if (open) el?.focus();
	});
</script>

<section
	class="fsp"
	class:open
	bind:this={el}
	tabindex="-1"
	aria-label="Now playing"
	aria-hidden={!open}
	inert={!open}
	style={dy > 0 ? `transform:translateY(${dy}px);transition:none` : ''}
	ontouchstart={(e) => (startY = e.touches[0]!.clientY)}
	ontouchmove={(e) => {
		const d = e.touches[0]!.clientY - startY;
		if (d > 0 && (el?.scrollTop ?? 0) <= 0) dy = d;
	}}
	ontouchend={() => {
		if (dy > 120) ui.close();
		dy = 0;
	}}
	onkeydown={(e) => e.key === 'Escape' && ui.close()}
>
	<div class="tbar">
		<button class="ibtn" aria-label="Close player" onclick={() => ui.close()}><Icon name="down" /></button>
		<div class="ctx">
			<span class="over">Playing from</span>
			<b class="ell">{player.contextInfo?.name ?? (v.context ? v.context.type : 'Spotify')}</b>
		</div>
		<span style="width:44px"></span>
	</div>
	{#if v.item}
		<div class="cover"><Art src={v.item.imageUrlLarge ?? v.item.imageUrl} size={360} alt={v.item.albumName ?? ''} /></div>
		<h2 class="ell" title={v.item.name}>{v.item.name}</h2>
		<div class="artist ell">{artistLine(v.item.artists)}</div>
		<div style="margin-top:10px"><Attribution uri={v.item.uri} /></div>
		<div style="margin-top:18px">
			<Scrubber variant="full" position={player.position} duration={v.item.durationMs} disabled={!!v.disallows.seeking} onseek={(ms) => player.seek(ms)} />
		</div>
		<div style="margin-top:10px"><Transport size="full" /></div>
		<div class="foot">
			<button class="devbtn" onclick={() => player.openDevices()}>
				<Icon name={player.sdkDriving ? 'laptop' : deviceIcon(v.device?.type)} size={18} />
				{player.deviceName ? `Playing on ${player.deviceName}` : 'No active device'}
			</button>
		</div>
		<HistoryCard stats={player.trackStats} />
	{:else}
		<p class="cap" style="margin-top:40px;text-align:center">Nothing playing.</p>
	{/if}
</section>

<style>
	.fsp {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: flex;
		flex-direction: column;
		padding: calc(var(--safe-top) + 8px) 24px calc(var(--safe-bottom) + 20px);
		background: linear-gradient(180deg, color-mix(in srgb, #3a2a66 75%, #000), var(--bg) 85%);
		transform: translateY(100%);
		transition: transform var(--t-sheet) var(--ease-emph);
		overflow-y: auto;
		outline: none;
	}
	.fsp.open {
		transform: none;
	}
	@media (min-width: 768px) {
		.fsp {
			display: none;
		}
	}
	.tbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 44px;
	}
	.ctx {
		text-align: center;
		font-size: 12px;
		line-height: 16px;
		min-width: 0;
	}
	.ctx b {
		display: block;
		font-size: 13px;
		color: var(--text-1);
		max-width: 240px;
	}
	.cover {
		margin: 24px auto;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
		border-radius: var(--r-art-l);
	}
	.cover :global(.art) {
		width: min(84vw, 360px) !important;
		height: min(84vw, 360px) !important;
	}
	h2 {
		font-size: 22px;
		line-height: 28px;
		font-weight: 800;
		letter-spacing: -0.02em;
	}
	.artist {
		font-size: 15px;
		color: var(--text-2);
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 12px;
	}
	.devbtn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 700;
		color: var(--accent-hover);
		padding: 6px 10px;
		border-radius: var(--r-pill);
	}
</style>
