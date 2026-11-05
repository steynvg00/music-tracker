<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsNav from '$lib/components/stats/StatsNav.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { YearReview } from '$lib/server/stats/sections';
	import { fmtInt } from '$lib/shared/format';
	import { diff, trackHref } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';

	let { data } = $props();
	const y = $derived(data.r.data as YearReview | null);
	const tiles = $derived(
		y
			? ([
					['Plays', y.current.plays, y.previous.plays],
					['Unique tracks', y.current.uniqueTracks, y.previous.uniqueTracks],
					['Unique artists', y.current.uniqueArtists, y.previous.uniqueArtists],
					['Listening days', y.current.days, y.previous.days]
				] as const)
			: []
	);
</script>

<svelte:head><title>Rotor · Year in review</title></svelte:head>

<div class="view">
	<Header title="Year in review" />
	<StatsNav />
	{#if !y}
		<StatsError r={data.r} />
	{:else}
		<div class="sec-h">
			<h2 class="big">{y.year}</h2>
			<label class="cap">Year
				<select value={y.year} onchange={(e) => goto(`?year=${e.currentTarget.value}`, { noScroll: true, keepFocus: true })}>
					{#each y.years as yr (yr)}<option value={yr}>{yr}</option>{/each}
				</select>
			</label>
		</div>
		<div class="tiles">
			{#each tiles as [label, cur, prev] (label)}
				{@const d = diff(cur, prev)}
				<StatTile {label} value={fmtInt(cur)} note="{d.text} vs {y.year - 1}" dir={d.dir} />
			{/each}
			<StatTile label="New artists" value={fmtInt(y.newArtists)} />
		</div>
		<section class="section">
			<div class="sec-h"><h2>Top 10 tracks</h2></div>
			<RankList
				label="Top tracks of {y.year}"
				source="Stats › Year in review {y.year}"
				rows={y.topTracks.map((t, i) => ({ key: `${t.artist}|${t.track}`, rank: i + 1, title: t.track, href: trackHref(t.uri), subtitle: t.artist, value: `${fmtInt(t.plays)} plays`, uri: t.uri }))}
			/>
		</section>
		<section class="section">
			<div class="sec-h"><h2>Top 10 artists</h2></div>
			<RankList label="Top artists of {y.year}" source="Stats › Year in review" playable={false} rows={y.topArtists.map((a, i) => ({ key: a.artist, rank: i + 1, title: a.artist, value: `${fmtInt(a.plays)} plays` }))} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Month by month</h2></div>
			<BarChart points={y.monthly} label="Plays per month in {y.year}" xLabel={shortPeriod} />
			{#if y.biggestMonth}<p class="cap muted">Biggest month: {shortPeriod(y.biggestMonth.month)} ({fmtInt(y.biggestMonth.plays)} plays)</p>{/if}
		</section>
	{/if}
</div>

<style>
	.big {
		font-size: 32px;
		font-weight: 800;
	}
	select {
		background: var(--surface-2);
		color: var(--text-1);
		border: 0;
		border-radius: 8px;
		padding: 6px 8px;
		font: inherit;
		margin-left: 6px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
		gap: 10px;
	}
	.tiles :global(.tile) {
		width: auto;
	}
</style>
