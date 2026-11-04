<script lang="ts">
	import Eq from './Eq.svelte';
	import Icon from './Icon.svelte';
	import Sheet from './Sheet.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { deviceIcon } from '$lib/shared/format';
	import { isPhoneLike } from '$lib/player/spotify-sdk';
	/**
	 * Device picker + "no active device" handling (03-ux-ia.md §8). With a pending intent
	 * (what you pressed Play on), picking a device plays it there directly; the wake flow
	 * finishes it server-side as soon as Spotify shows up. You never tap Play twice.
	 */
	const open = $derived(ui.sheet === 'devices');
	const list = $derived(player.connectDevices);
	const current = $derived(player.snapshot.device?.id ?? null);
	const phone = $derived(typeof window !== 'undefined' && isPhoneLike());
	const empty = $derived(!player.devicesLoading && list.length === 0 && !player.sdkReady);

	function close() {
		ui.close();
		if (player.wake !== 'waiting') player.pending = null;
	}
	function caption(d: (typeof list)[number]): string {
		if (d.isRestricted) return "Spotify doesn't allow remote control of this device";
		const state = d.id === current ? (player.view.isPlaying ? 'Playing' : 'Paused') : 'Spotify Connect';
		return d.supportsVolume ? state : `${state} · volume on device`;
	}
</script>

<Sheet {open} onclose={close} label="Play on">
	{#if player.wake === 'waiting'}
		<h3>Waiting for Spotify…</h3>
		<div class="wait"><span class="spin"></span><span class="cap">Opened the Spotify app. Rotor starts {player.pending?.label ?? 'playback'} as soon as it shows up (up to 12 s).</span></div>
		<button class="btn ghost" onclick={close}>Cancel</button>
	{:else if player.wake === 'timeout'}
		<h3>Still no Spotify device</h3>
		<p class="cap">Spotify didn't show up in time. Open the Spotify app, then try again.</p>
		<div class="acts">
			<a class="btn pri" href="spotify:" onclick={() => player.startWake()}>Open Spotify again</a>
			<button class="btn sec" onclick={() => player.retryDevices()}>Try again</button>
		</div>
	{:else if empty}
		<h3>Spotify isn't open anywhere</h3>
		<p class="cap">Phones drop off Spotify's device list when the app has been idle. Rotor keeps what you asked to play and starts it as soon as a device appears.</p>
		<a class="dev" href="spotify:" onclick={() => player.startWake()}>
			<Icon name="phone" />
			<span class="grow"><b>Open Spotify{phone ? ' on this phone' : ''}</b><span class="cap">Opens the Spotify app, then plays there automatically</span></span>
		</a>
		{#if player.sdkEnabled}
			<button
				class="dev"
				onclick={() => {
					player.activateSdkElement();
					void player.pickThisLaptop();
				}}
			>
				<Icon name="laptop" />
				<span class="grow"><b>Play on this laptop</b><span class="cap">{player.sdkError ? player.sdkError : 'Rotor becomes the speaker'}</span></span>
				{#if player.transferring === 'sdk'}<span class="spin"></span>{/if}
			</button>
		{/if}
		<button class="btn ghost" onclick={() => player.retryDevices()}>Try again</button>
	{:else}
		<h3>Play on</h3>
		<p class="cap sub">{player.pending ? `Choose where to play ${player.pending.label}` : 'Spotify Connect devices'}</p>
		{#if player.devicesLoading && !list.length}
			<div class="wait"><span class="spin"></span><span class="cap">Looking for your devices…</span></div>
		{/if}
		{#each list as d (d.id ?? d.name)}
			<button class="dev" class:cur={d.id === current} disabled={d.isRestricted || !d.id} onclick={() => d.id && player.pickDevice(d.id, d.name)}>
				<Icon name={deviceIcon(d.type)} />
				<span class="grow"><b class="ell">{d.name}</b><span class="cap">{caption(d)}</span></span>
				{#if player.transferring === d.id}<span class="spin"></span>{:else if d.id === current}<Eq paused={!player.view.isPlaying} />{/if}
			</button>
		{/each}
		{#if player.sdkEnabled}
			<button
				class="dev"
				class:cur={player.sdkDriving}
				onclick={() => {
					player.activateSdkElement();
					void player.pickThisLaptop();
				}}
			>
				<Icon name="laptop" />
				<span class="grow"><b>This laptop</b><span class="cap">{player.sdkError ? `Unavailable: ${player.sdkError}` : player.sdkReady ? 'Rotor web player · this browser' : 'Rotor web player · starts on tap'}</span></span>
				{#if player.transferring === 'sdk' || player.transferring === player.sdkDeviceId}<span class="spin"></span>{:else if player.sdkDriving}<Eq paused={!player.view.isPlaying} />{/if}
			</button>
		{/if}
		<p class="cap foot">Don't see your phone? <a href="spotify:" onclick={() => player.startWake()}>Open Spotify</a> and it will show up.</p>
	{/if}
</Sheet>

<style>
	h3 {
		margin: 4px 0 4px;
		font-size: 16px;
		font-weight: 800;
	}
	.sub {
		margin: 0 0 6px;
	}
	.dev {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 10px 8px;
		border-radius: var(--r-card);
		text-align: left;
		min-height: 56px;
	}
	.dev:hover {
		background: var(--surface-3);
	}
	.dev .grow {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.dev.cur,
	.dev.cur .cap {
		color: var(--accent-hover);
	}
	.dev[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.wait {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 4px;
	}
	.foot {
		margin: 10px 4px 0;
	}
	.foot a {
		color: var(--accent-hover);
		font-weight: 700;
	}
	.acts {
		display: flex;
		gap: 8px;
		margin-top: 12px;
		flex-wrap: wrap;
	}
	p.cap {
		margin: 4px 0 8px;
	}
</style>
