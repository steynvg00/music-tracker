<script lang="ts">
	import Art from './Art.svelte';
	import Icon from './Icon.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { artistLine, deviceIcon } from '$lib/shared/format';
	/** Mobile mini-player: floats above the tab bar; tap → full player, device line → picker. */
	const v = $derived(player.view);
	const pct = $derived(v.item?.durationMs ? (player.position / v.item.durationMs) * 100 : 0);
</script>

{#if v.item}
	<div class="mini" role="button" tabindex="0" aria-label="Open player" onclick={() => ui.open('player')} onkeydown={(e) => e.key === 'Enter' && ui.open('player')}>
		<Art src={v.item.imageUrl} size={40} />
		<div class="meta">
			<div class="t ell" title={v.item.name}>{v.item.name} <span class="muted">· {artistLine(v.item.artists)}</span></div>
			<button
				class="mdev"
				onclick={(e) => {
					e.stopPropagation();
					void player.openDevices();
				}}
			>
				{#if player.deviceName}<Icon name={player.sdkDriving ? 'laptop' : deviceIcon(v.device?.type)} size={12} /> {player.deviceName}{:else}<span class="warn">No active device</span>{/if}
			</button>
		</div>
		<button
			class="ibtn"
			aria-label={v.isPlaying ? 'Pause' : 'Play'}
			onclick={(e) => {
				e.stopPropagation();
				void player.togglePlay();
			}}
		>
			<Icon name={v.isPlaying ? 'pause' : 'play'} size={22} />
		</button>
		<div class="bar"><i style="width:{pct}%"></i></div>
	</div>
{/if}

<style>
	.mini {
		position: fixed;
		left: 8px;
		right: 8px;
		bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 8px);
		z-index: 19;
		height: var(--mini-h);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 4px 0 10px;
		border-radius: var(--r-card);
		background: color-mix(in srgb, #2a2140 30%, var(--surface-2));
		box-shadow: var(--shadow-pop);
		overflow: hidden;
		cursor: pointer;
	}
	.meta {
		flex: 1;
		min-width: 0;
	}
	.t {
		font-weight: 650;
		font-size: 14px;
	}
	.t .muted {
		font-weight: 500;
	}
	.mdev {
		font-size: 12px;
		line-height: 16px;
		color: var(--accent-hover);
		display: flex;
		align-items: center;
		gap: 4px;
		font-weight: 600;
		padding: 2px 0;
		max-width: 100%;
	}
	.warn {
		color: var(--warning);
	}
	.bar {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: 0;
		height: 2px;
		background: rgba(255, 255, 255, 0.12);
		border-radius: 2px;
	}
	.bar i {
		display: block;
		height: 100%;
		background: var(--text-1);
		transition: width 250ms linear;
	}
	@media (min-width: 768px) {
		.mini {
			display: none;
		}
	}
</style>
