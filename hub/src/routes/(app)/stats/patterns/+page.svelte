<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import HBars from '$lib/components/stats/HBars.svelte';
	import Heatmap from '$lib/components/stats/Heatmap.svelte';
	import StatsBar from '$lib/components/stats/StatsBar.svelte';
	import OptionSheet from '$lib/components/OptionSheet.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { Patterns } from '$lib/server/stats/core';
	import { fillDays } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';

	let { data } = $props();
	let yearOpen = $state(false);
	const p = $derived(data.r.data as Patterns | null);
	const today = new Date().toISOString().slice(0, 10);
	const daily = $derived(p ? fillDays(p.daily, `${p.year}-01-01`, String(p.year) === today.slice(0, 4) ? today : `${p.year}-12-31`) : []);
</script>

<svelte:head><title>Rotor · Patterns</title></svelte:head>

<div class="view">
	<Header title="Patterns" />
	<StatsBar menus={p ? [{ key: 'year', label: `Daily plays: ${p.year}`, onclick: () => (yearOpen = true) }] : []} />
	{#if p}
		<OptionSheet open={yearOpen} onclose={() => (yearOpen = false)} title="Year" sections={[{ key: 'year', title: 'Year', options: p.years.map((y) => ({ value: String(y), label: String(y) })), value: String(p.year), onselect: (v) => goto(`?year=${v}`, { noScroll: true, keepFocus: true }) }]} />
	{/if}
	{#if !p}
		<StatsError r={data.r} />
	{:else}
		<section class="section">
			<div class="sec-h">
				<h2>Daily plays · {p.year}</h2>
			</div>
			<BarChart points={daily} label="Plays per day in {p.year}" xLabel={shortPeriod} height={140} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>When you listen</h2><span class="cap muted">all time, Europe/Amsterdam</span></div>
			<Heatmap grid={p.heatmap} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Weekend vs weekday</h2></div>
			<div class="two">
				<div><h3>Weekend (Sat–Sun)</h3><HBars label="Top artists at the weekend" rows={p.weekend.map((a) => ({ label: a.name, value: a.plays }))} /></div>
				<div><h3>Weekday (Mon–Fri)</h3><HBars label="Top artists on weekdays" rows={p.weekday.map((a) => ({ label: a.name, value: a.plays }))} /></div>
			</div>
		</section>
	{/if}
</div>

<style>
	.two {
		display: grid;
		gap: 20px;
	}
	h3 {
		font-size: 14px;
		margin: 0 0 8px;
		color: var(--text-2);
	}
	@media (min-width: 900px) {
		.two {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
