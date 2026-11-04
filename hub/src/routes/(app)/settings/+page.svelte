<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import { getSdkMode, setSdkMode, type SdkMode } from '$lib/player/spotify-sdk';
	import { fmtDate } from '$lib/shared/format';
	import type { ConnectionStatus } from '$lib/server/spotify/token';

	let { data } = $props();
	let sdkMode = $state<SdkMode>('auto');
	onMount(() => (sdkMode = getSdkMode()));

	function pick(m: SdkMode) {
		sdkMode = m;
		setSdkMode(m);
	}
	function clearCaches() {
		void navigator.serviceWorker?.controller?.postMessage({ type: 'clear-data' });
	}
	const color = (c: ConnectionStatus) => (c.health === 'danger' ? 'var(--danger)' : c.health === 'warn' ? 'var(--warning)' : 'var(--success)');
</script>

<svelte:head><title>Rotor · Settings</title></svelte:head>

<div class="view">
	<Header title="Settings" />
	{#if data.notice}<p class="notice" class:err={data.notice.error} role="status">{data.notice.text}</p>{/if}

	<section class="section">
		<div class="sec-h"><h2>Connections</h2></div>

		{#each [data.connections.hub, data.connections.cron] as c (c.client)}
			<div class="conn">
				<div class="row1">
					<div>
						<b>{c.client === 'hub' ? 'Rotor (this app)' : 'Crons (GitHub Actions)'}</b>
						<div class="cap">
							{#if c.client === 'hub'}Player, Web Playback SDK and the Daily pick playlist. Rotor's own Spotify app.
							{:else}The crons read this token first (option A) and fall back to the GitHub secret SPOTIFY_REFRESH_TOKEN.{/if}
						</div>
					</div>
					{#if c.connected && c.daysLeft !== null}<span class="days tab-num" style="color:{color(c)}">{c.daysLeft} d</span>{/if}
				</div>
				{#if c.connected}
					<dl>
						<dt>Authorized</dt><dd>{fmtDate(c.authorizedAt)}</dd>
						<dt>Stops working ≈</dt><dd>{fmtDate(c.expiresAt)}</dd>
						<dt>{c.client === 'cron' ? 'Last used by a cron' : 'Last refresh'}</dt><dd>{c.lastRefreshAt ? fmtDate(c.lastRefreshAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}</dd>
						{#if c.lastError}<dt>Last error</dt><dd style="color:var(--danger)">{c.lastError}</dd>{/if}
					</dl>
				{:else}
					<p class="cap muted">{c.client === 'hub' ? 'Not connected.' : 'Not connected: the crons use the GitHub secret.'}</p>
				{/if}
				{#if c.client === 'hub'}
					<a class="btn sec" href="/auth/login?client=hub&reconnect=1&next=/settings" data-sveltekit-reload>Reconnect Spotify</a>
				{:else if data.cronConfigured}
					{#if !data.cronClientMatches}<p class="cap" style="color:var(--warning)">This row was minted for another Spotify app than SPOTIFY_CRON_CLIENT_ID. Reconnect the crons.</p>{/if}
					<a class="btn sec" href="/auth/login?client=cron" data-sveltekit-reload>{c.connected ? 'Reconnect crons' : 'Connect crons'}</a>
				{:else}
					<p class="cap muted">Add the cron app's Client ID and secret to the Vercel env (see hub/.env.example) to connect the crons from here.</p>
				{/if}
			</div>
		{/each}
		<p class="cap muted">Spotify refresh tokens stop working 6 months after you authorize; refreshing doesn't extend that. Reconnect resets the clock.</p>
	</section>

	<section class="section">
		<div class="sec-h"><h2>This device as a speaker</h2></div>
		<p class="cap">"This laptop" uses Spotify's Web Playback SDK. Auto = laptops and desktops only. On = also phones and tablets (R1 spike e: iPhone standalone PWA).</p>
		<div class="seg" role="radiogroup" aria-label="Web Playback SDK">
			{#each ['auto', 'on', 'off'] as const as m (m)}
				<button role="radio" aria-checked={sdkMode === m} class:on={sdkMode === m} onclick={() => pick(m)}>{m === 'auto' ? 'Auto' : m === 'on' ? 'On' : 'Off'}</button>
			{/each}
		</div>
		<p class="cap muted">Applies after a reload.</p>
	</section>

	<section class="section">
		<div class="sec-h"><h2>Data health</h2></div>
		<dl>
			<dt>Last play ingested</dt><dd>{fmtDate(data.lastPlayAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd>
			<dt>Playlist mirror</dt><dd>{data.mirrorAgeMin === null ? 'empty' : `updated ${data.mirrorAgeMin} min ago`}</dd>
			<dt>Shuffle the deck</dt><dd>{data.reseedAvailable ? 'on (GitHub dispatch)' : 'off: deck starts over'}</dd>
		</dl>
	</section>

	<section class="section">
		<div class="sec-h"><h2>Sign out</h2></div>
		<div class="acts">
			<form method="POST" action="/auth/logout" onsubmit={clearCaches}><button class="btn sec">Sign out</button></form>
			<form method="POST" action="/auth/logout" onsubmit={clearCaches}><input type="hidden" name="everywhere" value="1" /><button class="btn danger">Sign out everywhere</button></form>
		</div>
	</section>

	<p class="cap muted foot">Rotor v0.81 · personal, non-commercial. Spotify content is shown as Spotify provides it, with links back to Spotify.</p>
</div>

<style>
	.conn {
		background: var(--surface-2);
		border-radius: 12px;
		padding: 14px;
		margin-bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		align-items: flex-start;
	}
	.row1 {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
	}
	.days {
		font-size: 22px;
		font-weight: 800;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 16px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		color: var(--text-3);
	}
	dd {
		margin: 0;
	}
	.seg {
		display: inline-grid;
		grid-template-columns: repeat(3, 1fr);
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 3px;
		margin: 10px 0 6px;
	}
	.seg button {
		height: 36px;
		padding: 0 18px;
		border-radius: var(--r-pill);
		font-size: 13px;
		font-weight: 700;
		color: var(--text-2);
	}
	.seg button.on {
		color: var(--text-1);
		background: var(--surface-4);
	}
	.acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.notice.err {
		color: var(--danger);
	}
	.foot {
		margin-top: 28px;
	}
</style>
