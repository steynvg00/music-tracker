<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { apiPost, describeFailure, ApiFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { fmtDate } from '$lib/shared/format';
	import { RADAR_PLAYLIST_NAME, RADAR_SOURCE_LABEL, STATUS_LABEL, radarDate, type RadarRelease } from '$lib/shared/radar';

	let { data } = $props();
	const r = $derived(data.r.data);
	const list = $derived(r ? (data.view === 'recent' ? r.recent : r.upcoming) : []);
	let busy = $state(false);

	function nav(patch: Record<string, string | null>) {
		const q = new URLSearchParams();
		const next = { view: data.view === 'recent' ? 'recent' : null, artist: data.artist, followed: data.followedOnly ? '1' : null, ...patch };
		for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
		void goto(`/radar${q.size ? `?${q}` : ''}`, { noScroll: true, keepFocus: true });
	}

	function groups(items: RadarRelease[]): { label: string; items: RadarRelease[] }[] {
		const out: { label: string; items: RadarRelease[] }[] = [];
		for (const it of items) {
			const label = radarDate(it.date, it.precision);
			const last = out.at(-1);
			if (last && last.label === label) last.items.push(it);
			else out.push({ label, items: [it] });
		}
		return out;
	}

	async function updatePlaylist() {
		busy = true;
		try {
			const res = await apiPost<{ name: string; trackCount: number; created: boolean }>('/api/radar/playlist');
			toasts.show(`${res.created ? 'Created' : 'Updated'} ${res.name} · ${res.trackCount} tracks`);
			await invalidateAll();
		} catch (e) {
			toasts.error(e instanceof ApiFailure ? (e.body.message ?? describeFailure(e)) : describeFailure(e));
		} finally {
			busy = false;
		}
	}
	const href = (it: RadarRelease) => it.spotifyUrl ?? it.url;
</script>

<svelte:head><title>Rotor · Release radar</title></svelte:head>

<div class="view">
	<Header title="Release radar" />
	{#if !r}
		<StatsError r={data.r} />
	{:else}
		<p class="cap muted">New and upcoming releases from your top artists of the last 24 months{r.followedCount ? ` and ${r.followedCount} artist${r.followedCount === 1 ? '' : 's'} you follow in Rotor` : ''}.</p>
		<div class="seg" role="tablist" aria-label="Release radar view">
			<button role="tab" aria-selected={data.view === 'upcoming'} class:on={data.view === 'upcoming'} onclick={() => nav({ view: null })}>Coming up · {r.upcoming.length}</button>
			<button role="tab" aria-selected={data.view === 'recent'} class:on={data.view === 'recent'} onclick={() => nav({ view: 'recent' })}>Recently out · {r.recent.length}</button>
		</div>
		<div class="chips" aria-label="Filter by artist">
			<button class="chip" class:on={!data.artist && !data.followedOnly} onclick={() => nav({ artist: null, followed: null })}>All artists</button>
			<button class="chip" class:on={data.followedOnly} aria-pressed={data.followedOnly} onclick={() => nav({ followed: data.followedOnly ? null : '1' })}>Followed in Rotor</button>
			{#each r.artists as a (a.key)}
				<button class="chip" class:on={data.artist === a.key} aria-pressed={data.artist === a.key} onclick={() => nav({ artist: data.artist === a.key ? null : a.key })}>{a.name} · {a.count}</button>
			{/each}
		</div>

		{#if !list.length}
			<p class="empty">{data.view === 'recent' ? 'Nothing released in the last 60 days' : 'Nothing announced yet'}{data.artist || data.followedOnly ? ' for this filter' : ''}.</p>
		{:else}
			{#each groups(list) as g (g.label)}
				<section class="day" aria-label={g.label}>
					<h2 class="cap">{g.label}</h2>
					<ul>
						{#each g.items as it (it.id)}
							<li class="rel" data-status={it.status}>
								<div class="txt">
									{#if href(it)}<a class="t" href={href(it)} target="_blank" rel="noopener">{it.title}</a>{:else}<span class="t">{it.title}</span>{/if}
									<span class="a">{#if it.artistId}<a href="/artist/{it.artistId}">{it.artist}</a>{:else}{it.artist}{/if}{it.type ? ` · ${it.type}` : ''}{it.label ? ` · ${it.label}` : ''}</span>
									<span class="src">{#each it.sources as s (s)}<span class="sb">{RADAR_SOURCE_LABEL[s]}</span>{/each}</span>
								</div>
								<span class="st {it.status}">{STATUS_LABEL[it.status]}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		{/if}

		<section class="section">
			<div class="sec-h"><h2>Playlist</h2></div>
			<p class="cap muted">Writes only <b>{RADAR_PLAYLIST_NAME}</b>: the {r.playlistTracks} tracks of Spotify releases from the last 14 days.</p>
			<button class="btn" onclick={updatePlaylist} disabled={busy || !r.playlistTracks}>{busy ? 'Updating…' : 'Update playlist'}</button>
		</section>

		<section class="section health" aria-label="Sources">
			<div class="sec-h"><h2>Sources</h2>{#if r.lastRunAt}<span class="cap">last run {fmtDate(r.lastRunAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>{/if}</div>
			<ul>
				{#each r.sources as s (s.source)}
					<li data-source={s.source} data-ok={!s.lastError || (s.lastSuccessAt && s.lastErrorAt && s.lastSuccessAt > s.lastErrorAt) ? 'true' : 'false'}>
						<b>{RADAR_SOURCE_LABEL[s.source]}</b>
						{#if !s.enabled || (s.disabledReason && !s.lastSuccessAt)}
							<span class="muted">off{s.disabledReason ? `: ${s.disabledReason}` : ''}</span>
						{:else if s.failingSince}
							<span class="bad">failing since {fmtDate(s.failingSince)} ({s.consecutiveFailures}×): {s.lastError}</span>
						{:else if s.lastSuccessAt}
							<span class="muted">last success {fmtDate(s.lastSuccessAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {s.lastItems ?? 0} items</span>
						{:else}
							<span class="muted">not run yet (daily at 06:47)</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.muted {
		color: var(--text-3);
	}
	.seg {
		display: flex;
		gap: 4px;
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 4px;
		margin: 12px 0;
		width: fit-content;
	}
	.seg button {
		padding: 8px 14px;
		border-radius: var(--r-pill);
		color: var(--text-2);
		font-weight: 600;
		font-size: 13px;
	}
	.seg button.on {
		background: var(--surface-4);
		color: var(--text-1);
	}
	.chips {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		scrollbar-width: none;
		margin: 0 calc(-1 * var(--gutter)) 12px;
		padding: 0 var(--gutter);
	}
	.chip {
		flex: none;
		padding: 6px 12px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		color: var(--text-2);
		font-size: 13px;
		min-height: 32px;
	}
	.chip.on {
		background: var(--accent-subtle);
		color: var(--text-1);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.day h2 {
		margin: 18px 0 6px;
		color: var(--text-2);
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.rel {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--surface-2);
	}
	.txt {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.t {
		font-weight: 600;
		color: var(--text-1);
	}
	.a {
		color: var(--text-2);
		font-size: 13px;
	}
	.src {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.sb {
		font-size: 11px;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--surface-3);
		color: var(--text-2);
	}
	.st {
		flex: none;
		font-size: 12px;
		font-weight: 700;
		padding: 4px 10px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
	}
	.st.announced {
		color: var(--data-3);
	}
	.st.out {
		color: var(--accent-hover);
	}
	.st.in_library {
		color: var(--text-1);
	}
	.st.in_library::before {
		content: '✓ ';
	}
	.empty {
		color: var(--text-2);
		padding: 24px 0;
	}
	.health li {
		display: flex;
		gap: 10px;
		padding: 6px 0;
		font-size: 13px;
		flex-wrap: wrap;
	}
	.bad {
		color: var(--data-3);
	}
</style>
