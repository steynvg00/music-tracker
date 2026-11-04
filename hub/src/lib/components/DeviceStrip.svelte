<script lang="ts">
	import Eq from './Eq.svelte';
	import Icon from './Icon.svelte';
	import { player } from '$lib/stores/player.svelte';
	/** Home's device strip: "Playing on iPhone" / "Nothing playing" (03-ux-ia.md §4 row 1). */
	const v = $derived(player.view);
</script>

{#if player.loaded}
	{#if v.active && player.deviceName}
		<button class="devstrip" onclick={() => player.openDevices()}>
			<Eq paused={!v.isPlaying} />
			<span class="grow ell">{v.isPlaying ? 'Playing' : 'Paused'} on <b>{player.deviceName}</b>{#if v.item}<span class="muted"> · {v.item.name}</span>{/if}</span>
			<Icon name="devices" size={18} />
		</button>
	{:else}
		<button class="devstrip none" onclick={() => player.openDevices()}>
			<Icon name="devices" size={18} />
			<span class="grow"><b>Nothing playing</b><br /><span class="cap">Press Play and Rotor will help you pick or wake a device</span></span>
			<Icon name="right" size={18} />
		</button>
	{/if}
{/if}

<style>
	.devstrip {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-radius: var(--r-card);
		background: var(--surface-2);
		margin-top: 4px;
		width: 100%;
		text-align: left;
		min-height: 44px;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	b {
		font-weight: 700;
	}
	.devstrip.none {
		background: rgba(255, 181, 71, 0.08);
		border: 1px solid rgba(255, 181, 71, 0.25);
	}
</style>
