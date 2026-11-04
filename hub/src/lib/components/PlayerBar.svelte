<script lang="ts">
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';
	import Scrubber from './Scrubber.svelte';
	import Transport from './Transport.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { artistLine, deviceIcon } from '$lib/shared/format';
	/** Laptop player bar (80 px): now playing · transport + scrubber · device, panel, volume. */
	const v = $derived(player.view);
	let volDrag = $state<number | null>(null);
	const vol = $derived(volDrag ?? v.device?.volumePercent ?? 0);

	function volFrom(e: PointerEvent, el: HTMLElement): number {
		const r = el.getBoundingClientRect();
		return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100);
	}
</script>

<footer class="playerbar" aria-label="Player">
	<div class="left">
		{#if v.item}
			<button class="artbtn" aria-label="Toggle now-playing panel" onclick={() => (ui.rightPanel = !ui.rightPanel)}><Art src={v.item.imageUrl} size={56} /></button>
			<div class="meta">
				<div class="t ell" title={v.item.name}>{v.item.name}</div>
				<div class="cap ell" title={artistLine(v.item.artists)}>{artistLine(v.item.artists)}</div>
			</div>
		{:else if player.loaded}
			<span class="cap muted">Nothing playing. Drop the kick?</span>
		{/if}
	</div>
	<div class="mid">
		<Transport />
		<Scrubber position={player.position} duration={v.item?.durationMs ?? 0} disabled={!v.item || !!v.disallows.seeking} onseek={(ms) => player.seek(ms)} />
	</div>
	<div class="right">
		<button class="devbtn" class:remote={!player.sdkDriving && !!player.deviceName} onclick={() => player.openDevices()} aria-label="Devices">
			<Icon name={player.sdkDriving ? 'laptop' : player.deviceName ? deviceIcon(v.device?.type) : 'devices'} size={18} />
			<span class="ell">{player.deviceName ?? 'No device'}</span>
		</button>
		<button class="ibtn" class:on={ui.rightPanel} aria-label="Now-playing panel" onclick={() => (ui.rightPanel = !ui.rightPanel)}><Icon name="panel" size={18} /></button>
		{#if v.device?.supportsVolume}
			<Icon name="vol" size={18} />
			<div
				class="vol"
				role="slider"
				tabindex="0"
				aria-label="Volume"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={vol}
				onpointerdown={(e) => {
					(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
					volDrag = volFrom(e, e.currentTarget as HTMLElement);
				}}
				onpointermove={(e) => volDrag !== null && (volDrag = volFrom(e, e.currentTarget as HTMLElement))}
				onpointerup={() => {
					if (volDrag !== null) void player.setVolume(volDrag);
					volDrag = null;
				}}
				onkeydown={(e) => {
					if (e.key === 'ArrowRight' || e.key === 'ArrowUp') void player.setVolume(vol + 5);
					else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') void player.setVolume(vol - 5);
					else return;
					e.preventDefault();
					e.stopPropagation();
				}}
			>
				<i style="width:{vol}%"></i>
			</div>
		{:else if v.device}
			<span class="cap muted" title="This device doesn't support remote volume">vol. on device</span>
		{/if}
	</div>
</footer>

<style>
	.playerbar {
		display: none;
	}
	@media (min-width: 768px) {
		.playerbar {
			display: grid;
			grid-column: 1 / -1;
			grid-row: 2;
			grid-template-columns: minmax(200px, 1fr) minmax(340px, 1.4fr) minmax(220px, 1fr);
			align-items: center;
			gap: 16px;
			padding: 0 8px;
			height: 80px;
		}
	}
	.left {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.meta {
		min-width: 0;
	}
	.t {
		font-weight: 700;
		font-size: 14px;
	}
	.mid {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}
	.right {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		color: var(--text-2);
		min-width: 0;
	}
	.devbtn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 700;
		padding: 6px 10px;
		border-radius: var(--r-pill);
		max-width: 180px;
		color: var(--text-2);
	}
	.devbtn.remote {
		color: var(--accent-hover);
	}
	.devbtn:hover {
		background: var(--surface-3);
	}
	.vol {
		width: 96px;
		height: 16px;
		position: relative;
		cursor: pointer;
		touch-action: none;
	}
	.vol::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 6px;
		height: 4px;
		border-radius: 2px;
		background: var(--surface-4);
	}
	.vol i {
		position: absolute;
		left: 0;
		top: 6px;
		height: 4px;
		background: var(--text-2);
		border-radius: 2px;
	}
	.vol:hover i {
		background: var(--accent);
	}
	.artbtn {
		border-radius: var(--r-art-s);
	}
</style>
