<script lang="ts">
	import { isWrappedPlaylistName } from '$lib/shared/wrapped';
	import { isRadarPlaylistName } from '$lib/shared/radar';
	import { goto, invalidateAll } from '$app/navigation';
	import Art from '$lib/components/Art.svelte';
	import Attribution from '$lib/components/Attribution.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import JobStatus from '$lib/components/JobStatus.svelte';
	import KindBadge from '$lib/components/KindBadge.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import TrackRows from '$lib/components/TrackRows.svelte';
	import { customSheet } from '$lib/components/custom-playlist-sheet/store.svelte';
	import { apiPost, ApiFailure, describeFailure } from '$lib/player/api-client';
	import { JobTracker } from '$lib/stores/jobs.svelte';
	import { library } from '$lib/stores/library.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { ttlLabel } from '$lib/shared/custom';
	import { fmtDate } from '$lib/shared/format';
	import { editable } from '$lib/shared/library';
	import { ORDER_PREFS, type OrderPref } from '$lib/shared/order-prefs';
	import type { JobRow } from '$lib/shared/jobs';

	let { data } = $props();
	const d = $derived(data.detail);
	const p = $derived(d.playlist);
	const canEdit = $derived(editable(p));
	const playing = $derived(player.view.context?.uri === p.uri && player.view.isPlaying);
	let orderPref = $state<string>('default');
	let busy = $state<string | null>(null);
	let confirmDelete = $state(false);
	const tracker = new JobTracker((job) => {
		if (job.status === 'done') void invalidateAll();
	});

	$effect.pre(() => {
		orderPref = d.settings.orderPref;
		tracker.track(d.job);
	});

	async function act(label: string, fn: () => Promise<unknown>, ok?: string) {
		busy = label;
		try {
			await fn();
			if (ok) toasts.show(ok);
		} catch (e) {
			toasts.error(e instanceof ApiFailure && e.status === 403 ? 'This playlist is read + play only.' : e instanceof ApiFailure ? (e.body.message ?? describeFailure(e)) : describeFailure(e));
		} finally {
			busy = null;
		}
	}

	const custom = (action: string) => apiPost(`/api/custom/${p.id}`, { action });

	function play(i?: number) {
		if (i === undefined && player.view.context?.uri === p.uri) return void player.togglePlay();
		void player.playContext(p.uri, p.name, i === undefined ? undefined : { position: i });
	}
	// R6: "Wrapped <year> · Auto 🤖📸" is written by Rotor Wrapped, not by the snapshot rebuild.
	const wrappedYear = $derived(isWrappedPlaylistName(p.name) ? Number(p.name.slice(8, 12)) : null);
</script>

<svelte:head><title>Rotor · {p.name}</title></svelte:head>

<div class="view">
	<div class="dhead">
		<button class="backbtn" aria-label="Back" onclick={() => history.back()}><Icon name="back" size={18} /></button>
		<Art src={p.imageUrl} size={200} alt="" />
		<div class="htext">
			<div class="over">Playlist</div>
			<h1 title={p.name}>{p.name}</h1>
			<div class="meta">
				<KindBadge kind={p.kind} isOwned={p.isOwned} isCollab={p.isCollab} />
				{#if d.custom}<span class="badge {d.custom.expiresAt ? 'warn' : ''}">{ttlLabel(d.custom.expiresAt)}</span>{/if}
				<span class="cap">{p.trackCount ?? '?'} tracks{p.isOwned ? '' : p.ownerName ? ` · by ${p.ownerName}` : ''}</span>
			</div>
			<div class="acts">
				<button class="play xl" aria-label={playing ? 'Pause' : 'Play'} onclick={() => play()}><Icon name={playing ? 'pause' : 'play'} /></button>
				{#if canEdit && p.kind === 'custom'}
					<button class="btn sec" onclick={() => customSheet.openEdit({ playlistId: p.id, name: p.name, filters: d.custom?.filters ?? null, excluded: d.custom?.excluded ?? [] }, () => void invalidateAll())}>
						Edit
					</button>
				{/if}
				<span class="spacer"></span>
				<Attribution uri={p.uri} />
			</div>
		</div>
	</div>

	{#if canEdit && p.kind === 'custom' && d.custom}
		<section class="panel" aria-label="Lifetime">
			<h3>Lifetime</h3>
			<p class="cap">{d.custom.expiresAt ? `Deletes on ${fmtDate(d.custom.expiresAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Kept until you delete it'} · made {fmtDate(d.custom.createdAt)}</p>
			{#if d.custom.filtersSummary}<p class="cap muted">Filters: {d.custom.filtersSummary}</p>{/if}
			<div class="row-acts">
				<button class="btn sec" disabled={!!busy} onclick={() => act('extend', async () => { await custom('extend'); await invalidateAll(); }, 'Extended by 7 days')}>Extend +7 d</button>
				{#if d.custom.expiresAt}<button class="btn sec" disabled={!!busy} onclick={() => act('keep', async () => { await custom('keep'); await invalidateAll(); }, 'Kept')}>Keep</button>{/if}
				<button class="btn danger" disabled={!!busy} onclick={() => (confirmDelete = true)}>Delete now</button>
			</div>
		</section>
	{/if}

	{#if canEdit && p.kind === 'auto_updating' && isRadarPlaylistName(p.name)}
		<section class="panel" aria-label="Managed settings">
			<h3>Release radar</h3>
			<p class="cap">Spotify releases of the last 14 days from your artists. Rewritten only by "Update playlist" on the Release radar.</p>
			<div class="row-acts"><a class="btn sec" href="/radar">Open Release radar</a></div>
		</section>
	{:else if canEdit && p.kind === 'auto_updating'}
		<section class="panel" aria-label="Managed settings">
			<h3>Sort order</h3>
			<p class="cap">Applied at the next refresh{d.nextRefresh ? ` (${fmtDate(d.nextRefresh, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})` : ''} or right away with Refresh now.</p>
			<div class="row-acts">
				<select
					class="select"
					aria-label="Sort order"
					bind:value={orderPref}
					onchange={() => act('order', () => apiPost(`/api/playlists/${p.id}/order`, { order_pref: orderPref as OrderPref }), 'Sort order saved')}
				>
					{#each Object.entries(ORDER_PREFS) as [k, label] (k)}<option value={k}>{label}</option>{/each}
				</select>
				<button
					class="btn sec"
					disabled={!d.jobsAvailable || !!tracker.view?.busy || !!busy}
					title={d.jobsAvailable ? '' : 'Needs the GitHub dispatch token (Settings › Data health)'}
					onclick={() => act('refresh', async () => tracker.track((await apiPost<{ job: JobRow }>(`/api/playlists/${p.id}/refresh`)).job))}
				>
					<Icon name="rotate" size={16} /> Refresh now
				</button>
			</div>
			<JobStatus {tracker} />
		</section>
	{/if}

	{#if canEdit && p.kind === 'auto_snapshot' && wrappedYear}
		<section class="panel" aria-label="Snapshot">
			<h3>Rotor Wrapped</h3>
			<p class="cap">Your top 100 of {wrappedYear}. Rewritten only by "Play your top 100" in Rotor Wrapped.</p>
			<div class="row-acts"><a class="btn sec" href="/wrapped/{wrappedYear}">Open Rotor Wrapped {wrappedYear}</a></div>
		</section>
	{:else if canEdit && p.kind === 'auto_snapshot'}
		<section class="panel" aria-label="Snapshot">
			<h3>Snapshot</h3>
			<p class="cap">Frozen. Rebuild re-runs its selection and rewrites it{d.jobsAvailable ? ' now' : ' at the next daily jobs run'}.
				{#if d.settings.forceRefreshRequestedAt && (!d.settings.forceRefreshCompletedAt || d.settings.forceRefreshRequestedAt > d.settings.forceRefreshCompletedAt)}Rebuild pending since {fmtDate(d.settings.forceRefreshRequestedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.{/if}</p>
			<div class="row-acts">
				<button
					class="btn sec"
					disabled={!!tracker.view?.busy || !!busy}
					onclick={() => act('rebuild', async () => {
						const r = await apiPost<{ job: JobRow | null }>(`/api/playlists/${p.id}/rebuild`);
						if (r.job) tracker.track(r.job);
						else await invalidateAll();
					}, d.jobsAvailable ? undefined : 'Rebuild requested')}
				>
					Rebuild
				</button>
			</div>
			<JobStatus {tracker} />
		</section>
	{/if}

	{#if d.category}
		<section class="panel about" aria-label="About this playlist">
			<h3>About this playlist</h3>
			<p class="rule">{d.category.ruleNl}</p>
			<dl>
				<dt>Rule</dt><dd><a href="/rules#{d.category.key}">{d.category.name}</a></dd>
				<dt>{d.category.scheduleKind === 'refresh' ? 'Refreshes' : 'Created'}</dt><dd>{d.category.scheduleNl}</dd>
				{#if d.nextRefresh}<dt>Next refresh</dt><dd>{fmtDate(d.nextRefresh, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</dd>{/if}
				{#if d.category.nextCreationNl}<dt>Next in series</dt><dd>{d.category.nextCreationNl}</dd>{/if}
			</dl>
			{#if d.category.notes}<details><summary class="cap">Notes</summary><p class="cap">{d.category.notes}</p></details>{/if}
		</section>
	{:else if !p.kind}
		<div class="notice"><Icon name="lock" size={18} /><span>{p.isOwned || p.isCollab ? 'Your own playlist without a managed suffix: read & play only. Rotor never edits it.' : 'You follow this playlist but don’t own it: play only.'}</span></div>
	{/if}

	{#if d.tracks.rows.length}
		<TrackRows rows={d.tracks.rows} contextUri={p.uri} onplayat={(i) => play(i)} />
	{:else if !d.tracks.readable}
		<p class="cap muted list-note">Spotify only returns track lists for playlists you own or collaborate on. Play it to hear it.</p>
	{:else}
		<p class="cap muted list-note">No tracks yet.</p>
	{/if}
</div>

<Sheet open={confirmDelete} onclose={() => (confirmDelete = false)} label="Delete playlist">
	<h3 class="ctitle">Delete {p.name}?</h3>
	<p class="cap">Deletes the playlist from your Spotify library. This can't be undone from Rotor.</p>
	<div class="row-acts">
		<button
			class="btn danger"
			disabled={!!busy}
			onclick={() => act('delete', async () => {
				await custom('delete');
				confirmDelete = false;
				library.invalidate();
				await goto('/library');
			}, 'Deleted')}
		>
			Delete
		</button>
		<button class="btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
	</div>
</Sheet>

<style>
	.dhead {
		position: relative;
		margin: 0 calc(-1 * var(--gutter));
		padding: calc(var(--safe-top) + 56px) var(--gutter) 16px;
		background: linear-gradient(180deg, color-mix(in srgb, #3a2a66 80%, #000) 0%, var(--bg) 100%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}
	.htext {
		width: 100%;
	}
	.backbtn {
		position: absolute;
		top: calc(var(--safe-top) + 12px);
		left: 16px;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: rgba(0, 0, 0, 0.35);
	}
	h1 {
		font-size: 28px;
		line-height: 32px;
		font-weight: 800;
		letter-spacing: -0.03em;
		word-break: break-word;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 16px;
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.play.xl {
		width: 56px;
		height: 56px;
	}
	.panel {
		background: var(--surface-2);
		border-radius: 12px;
		padding: 14px;
		margin-top: 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.panel h3 {
		font-size: 15px;
		font-weight: 800;
	}
	.row-acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: center;
	}
	.select {
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		color: var(--text-1);
		border: 0;
		padding: 0 14px;
		font: inherit;
	}
	.rule {
		font-size: 14px;
		line-height: 20px;
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
	dd a {
		text-decoration: underline;
	}
	.list-note {
		margin-top: 16px;
	}
	.ctitle {
		font-size: 16px;
		font-weight: 800;
		margin: 4px 0;
	}
	@media (min-width: 768px) {
		.dhead {
			flex-direction: row;
			align-items: flex-end;
			gap: 24px;
			padding-top: 64px;
			background: linear-gradient(180deg, color-mix(in srgb, #3a2a66 80%, #000) 0%, var(--surface-1) 100%);
			border-radius: 10px 10px 0 0;
		}
		.htext {
			flex: 1;
			min-width: 0;
		}
		h1 {
			font-size: 48px;
			line-height: 52px;
		}
	}
</style>
