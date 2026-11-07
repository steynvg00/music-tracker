<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import HBars from '$lib/components/stats/HBars.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { shortPeriod } from '$lib/stats-client';
	import { trackHref } from '$lib/shared/stats';
	import type { Neighbour, PhantomPayload } from '$lib/server/phantom';

	let { data } = $props();
	const p = $derived(data.r.data as PhantomPayload | null);
	const when = (s: string) => fmtDate(s, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	const time = (s: string) => fmtDate(s, { hour: '2-digit', minute: '2-digit' });
	const secs = (ms: number | null) => (ms === null ? '—' : ms >= 60000 ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}` : `${Math.round(ms / 1000)} s`);
</script>

<svelte:head><title>Rotor · Phantom plays</title></svelte:head>

{#snippet nb(n: Neighbour | null, dir: 'before' | 'after')}
	{#if n}
		{@const href = trackHref(n.uri)}
		<span class="nb"><span class="muted">{dir === 'before' ? 'Before:' : 'After:'}</span>
			{#if href}<a {href}>{n.name ?? n.uri}</a>{:else}{n.name ?? n.uri}{/if}{#if n.artist}<span class="muted"> — {n.artist}</span>{/if}
			<span class="muted">({time(n.at)})</span></span>
	{/if}
{/snippet}

<div class="view">
	<Header title="Phantom plays" />
	<p class="cap"><a href="/settings/health">‹ Data health</a></p>
	<p class="cap muted">
		Plays where Spotify's recently-played API sent no track at all: usually tracks that were later removed from Spotify's catalog. The plays are real, but what they were is lost.
		The same rows as Streamlit's Phantom plays tab (no track, artist or title), so podcast episodes count too. Each play shows the identified track around it, the only clue left.
	</p>
	{#if !p}
		<StatsError r={data.r} />
	{:else}
		<div class="tiles" data-testid="phantom-summary">
			<div class="tile"><span class="cap">Total phantom plays</span><b class="tab-num" data-testid="phantom-total">{fmtInt(p.total)}</b>{#if p.episodes}<span class="cap muted">{fmtInt(p.episodes)} podcast/audiobook</span>{/if}</div>
			<div class="tile"><span class="cap">Earliest</span><b class="tab-num">{p.earliest ?? '—'}</b></div>
			<div class="tile"><span class="cap">Latest</span><b class="tab-num">{p.latest ?? '—'}</b></div>
		</div>
		{#if p.total === 0}
			<p class="cap">No phantom plays found.</p>
		{:else}
			<section class="section">
				<div class="sec-h"><h2>Phantom plays over time</h2></div>
				<BarChart points={p.byMonth.map((m) => ({ x: m.month, y: m.count }))} label="Phantom plays per month" xLabel={shortPeriod} />
				<p class="cap muted">If this is rising, more tracks are being delisted from Spotify recently.</p>
			</section>
			<section class="section two">
				<div>
					<div class="sec-h"><h2>By platform</h2></div>
					<HBars rows={p.byPlatform.map((r) => ({ label: r.platform, value: r.count }))} label="Phantom plays by platform" />
				</div>
				<div>
					<div class="sec-h"><h2>By reason end</h2></div>
					<HBars rows={p.byReasonEnd.map((r) => ({ label: r.reasonEnd, value: r.count }))} label="Phantom plays by end reason" />
				</div>
			</section>
			<section class="section">
				<div class="sec-h"><h2>Recent phantom plays (last {Math.min(p.limit, p.total)})</h2></div>
				<ol class="plays" data-testid="phantom-list">
					{#each p.recent as r (r.playedAt + r.platform)}
						<li>
							<span class="at tab-num">{when(r.playedAt)}</span>
							<span class="meta">{r.media ? `${r.media} · ` : ''}{r.platform} · {r.reasonEnd} · {secs(r.msPlayed)}</span>
							<span class="ctx">{@render nb(r.before, 'before')}{#if r.before && r.after}<span class="muted"> · </span>{/if}{@render nb(r.after, 'after')}{#if !r.before && !r.after}<span class="muted">no identified track within a day</span>{/if}</span>
						</li>
					{/each}
				</ol>
				{#if p.total > p.limit && p.limit < 300}
					<a class="btn sec" href="?limit={Math.min(300, p.limit + 30)}" data-sveltekit-noscroll>Show 30 more</a>
				{/if}
			</section>
		{/if}
	{/if}
</div>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin: 12px 0 4px;
	}
	.tile {
		background: var(--surface-2);
		border-radius: 12px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.tile b {
		font-size: 20px;
	}
	.two {
		display: grid;
		gap: 20px;
	}
	@media (min-width: 768px) {
		.two {
			grid-template-columns: 1fr 1fr;
		}
	}
	.plays {
		list-style: none;
		padding: 0;
		margin: 0 0 14px;
		display: grid;
		gap: 10px;
		font-size: 13px;
	}
	.plays li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		border-bottom: 1px solid var(--surface-3, var(--surface-2));
		padding-bottom: 8px;
	}
	.at {
		font-weight: 700;
	}
	.meta,
	.nb .muted {
		color: var(--text-3);
	}
</style>
