<script lang="ts">
	import { mixesEnabled, setMixesEnabled, POLICY_WARNING } from '$lib/conductor/opt-in';
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import { getSdkMode, setSdkMode, type SdkMode } from '$lib/player/spotify-sdk';
	import { fmtDate } from '$lib/shared/format';
	import type { ConnectionStatus } from '$lib/server/spotify/token';
	import { invalidateAll } from '$app/navigation';
	import JobStatus from '$lib/components/JobStatus.svelte';
	import { JobTracker } from '$lib/stores/jobs.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { apiPost, describeFailure } from '$lib/player/api-client';
	import { currentSubscription, disablePush, enablePush, needsInstall, pushSupported } from '$lib/push-client';
	import { describeJob, JOB_KIND_LABEL, type JobRow } from '$lib/shared/jobs';

	let { data } = $props();
	let sdkMode = $state<SdkMode>('auto');
	let pushState = $state<'unknown' | 'on' | 'off' | 'unsupported' | 'install'>('unknown');
	let pushBusy = $state(false);
	const testJob = new JobTracker(() => void invalidateAll());
	onMount(() => {
		sdkMode = getSdkMode();
		if (!pushSupported()) pushState = needsInstall() ? 'install' : 'unsupported';
		else void currentSubscription().then((s) => (pushState = s ? 'on' : 'off'));
	});

	async function turnOn() {
		if (!data.push.publicKey) return;
		pushBusy = true;
		try {
			const r = await enablePush(data.push.publicKey);
			pushState = r === 'enabled' ? 'on' : 'off';
			if (r === 'denied') toasts.error('Notifications are blocked for Rotor in this browser’s settings.');
			await invalidateAll();
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			pushBusy = false;
		}
	}
	async function turnOff() {
		pushBusy = true;
		try {
			await disablePush();
			pushState = 'off';
			await invalidateAll();
		} finally {
			pushBusy = false;
		}
	}
	async function sendTest() {
		try {
			testJob.track((await apiPost<{ job: JobRow }>('/api/push/test')).job);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}

	function pick(m: SdkMode) {
		sdkMode = m;
		setSdkMode(m);
	}
	function clearCaches() {
		void navigator.serviceWorker?.controller?.postMessage({ type: 'clear-data' });
	}
	const color = (c: ConnectionStatus) => (c.health === 'danger' ? 'var(--danger)' : c.health === 'warn' ? 'var(--warning)' : 'var(--success)');
	let mixesOn = $state(false);
	$effect(() => {
		mixesOn = mixesEnabled();
	});
	function toggleMixes() {
		if (mixesOn) {
			setMixesEnabled(false);
			mixesOn = false;
			return;
		}
		if (!confirm(POLICY_WARNING)) return;
		setMixesEnabled(true);
		mixesOn = true;
	}
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

	<section class="section" id="experimental" aria-label="Experimental">
		<div class="sec-h"><h2>Experimental</h2></div>
		<p class="cap"><b>Mixed sessions</b> (conflicts with Spotify’s developer policy): play Spotify and YouTube/SoundCloud items in one session, one after another. Off by default, per device.</p>
		<button class="btn {mixesOn ? 'sec' : 'ghost'}" aria-pressed={mixesOn} onclick={toggleMixes}>{mixesOn ? 'On for this device — turn off' : 'Turn on for this device…'}</button>
	</section>

	<section class="section" aria-label="Elsewhere sources">
		<div class="sec-h"><h2>Elsewhere</h2></div>
		<p class="cap"><b>YouTube:</b> {data.youtubeKey ? 'API key configured: public and unlisted playlists can be imported.' : 'Not set up: add the YouTube Data API key to the hub’s server environment (Vercel) to import playlists.'}</p>
		<p class="cap"><b>SoundCloud:</b> no key needed (oEmbed + the official widget).</p>
	</section>

	<section class="section">
		<div class="sec-h"><h2>Notifications</h2></div>
		<p class="cap">Today's pick is ready, Spotify sign-in expiring (14 and 3 days ahead), and when a job you started finishes.</p>
		{#if !data.push.publicKey}
			<p class="cap muted">Not set up: add the VAPID public key to the Vercel env and the private key + subject to the GitHub secrets (see hub/.env.example).</p>
		{:else if pushState === 'install'}
			<p class="cap">On iPhone, add Rotor to the Home Screen first (Share › Add to Home Screen), then open it from there.</p>
		{:else if pushState === 'unsupported'}
			<p class="cap muted">This browser doesn't support Web Push.</p>
		{:else}
			<div class="acts">
				{#if pushState === 'on'}
					<button class="btn sec" disabled={pushBusy} onclick={turnOff}>Turn off on this device</button>
					<button class="btn sec" disabled={!data.reseedAvailable || !!testJob.view?.busy} onclick={sendTest}>Send a test</button>
				{:else}
					<button class="btn pri" disabled={pushBusy || pushState === 'unknown'} onclick={turnOn}>Turn on for this device</button>
				{/if}
			</div>
			<JobStatus tracker={testJob} />
		{/if}
		<p class="cap muted">{data.push.devices} device{data.push.devices === 1 ? '' : 's'} subscribed.</p>
	</section>

	<section class="section">
		<div class="sec-h"><h2>Jobs</h2></div>
		{#if !data.reseedAvailable}<p class="cap muted">Jobs need the GitHub dispatch token in the Vercel env (see hub/.env.example). Without it, Refresh now and Rebuild wait for the daily run, and Shuffle the deck starts over.</p>{/if}
		{#if data.jobs.length}
			<ul class="jobs">
				{#each data.jobs as j (j.id)}
					{@const v = describeJob(j)}
					<li data-status={j.status}><b>{JOB_KIND_LABEL[j.kind]}</b> <span class="badge {v.tone === 'danger' ? 'warn' : ''}">{v.label}</span> <span class="cap">{fmtDate(j.requestedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{v.detail ? ` · ${v.detail}` : ''}</span></li>
				{/each}
			</ul>
		{:else}
			<p class="cap muted">No jobs yet.</p>
		{/if}
	</section>

	<section class="section">
		<div class="sec-h"><h2>Data health</h2></div>
		<dl>
			<dt>Last play ingested</dt><dd>{fmtDate(data.lastPlayAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd>
			<dt>Playlist mirror</dt><dd>{data.mirrorAgeMin === null ? 'empty' : `updated ${data.mirrorAgeMin} min ago`}</dd>
			<dt>Hub jobs</dt><dd>{data.reseedAvailable ? 'on (GitHub dispatch)' : 'off: no GitHub dispatch token'}</dd>
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
	.jobs {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13px;
	}
	.foot {
		margin-top: 28px;
	}
</style>
