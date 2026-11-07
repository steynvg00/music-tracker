<script lang="ts">
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsBar from '$lib/components/stats/StatsBar.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { OnThisDayYear } from '$lib/server/stats/core';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { trackHref } from '$lib/shared/stats';

	let { data } = $props();
	const o = $derived(data.r.data as { date: string; years: OnThisDayYear[] } | null);
	const focus = $derived(Number(page.url.searchParams.get('year')) || null);
</script>

<svelte:head><title>Rotor · On this day</title></svelte:head>

<div class="view">
	<Header title="On this day" />
	<StatsBar />
	{#if !o}
		<StatsError r={data.r} />
	{:else}
		<p class="cap muted">What you played on {fmtDate(`${o.date}T12:00:00Z`, { day: 'numeric', month: 'long' })} in past years.</p>
		{#each o.years as y, i (y.year)}
			<details class="yr" open={focus ? focus === y.year : i === 0}>
				<summary><b>{y.year}</b> <span class="cap muted">{fmtInt(y.plays)} plays</span></summary>
				<RankList
					label="{fmtDate(`${o.date}T12:00:00Z`, { day: 'numeric', month: 'short' })} {y.year}"
					source="Stats › On this day {y.year}"
					rows={y.tracks.map((t, j) => ({ key: `${t.artist}|${t.track}`, rank: j + 1, title: t.track, href: trackHref(t.uri), subtitle: t.artist, value: `${fmtInt(t.plays)}×`, uri: t.uri }))}
				/>
			</details>
		{:else}
			<p class="muted">Nothing on this date yet.</p>
		{/each}
	{/if}
</div>

<style>
	.yr {
		margin-top: 12px;
		background: var(--surface-1);
		border-radius: var(--r-card);
		padding: 10px 12px;
	}
	summary {
		cursor: pointer;
		font-size: 16px;
		min-height: 32px;
		display: flex;
		gap: 10px;
		align-items: center;
	}
</style>
