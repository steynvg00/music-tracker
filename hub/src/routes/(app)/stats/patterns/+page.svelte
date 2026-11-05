<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import HBars from '$lib/components/stats/HBars.svelte';
	import Heatmap from '$lib/components/stats/Heatmap.svelte';
	import StatsNav from '$lib/components/stats/StatsNav.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { Patterns } from '$lib/server/stats/core';
	import { fillDays } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';

	let { data } = $props();
	const p = $derived(data.r.data as Patterns | null);
	const today = new Date().toISOString().slice(0, 10);
	const daily = $derived(p ? fillDays(p.daily, `${p.year}-01-01`, String(p.year) === today.slice(0, 4) ? today : `${p.year}-12-31`) : []);
</script>

<svelte:head><title>Rotor · Patterns</title></svelte:head>

<div class="view">
	<Header title="Patterns" />
	<StatsNav />
	{#if !p}
		<StatsError r={data.r} />
	{:else}
		<section class="section">
			<div class="sec-h">
				<h2>Daily plays</h2>
				<label class="cap">Year
					<select value={p.year} onchange={(e) => goto(`?year=${e.currentTarget.value}`, { noScroll: true, keepFocus: true })}>
						{#each p.years as y (y)}<option value={y}>{y}</option>{/each}
					</select>
				</label>
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
	select {
		background: var(--surface-2);
		color: var(--text-1);
		border: 0;
		border-radius: 8px;
		padding: 6px 8px;
		font: inherit;
		margin-left: 6px;
	}
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
