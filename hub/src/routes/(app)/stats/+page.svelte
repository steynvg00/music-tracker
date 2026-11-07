<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import StatsBar from '$lib/components/stats/StatsBar.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { WEEKDAYS_SUN } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';

	let { data } = $props();
	const o = $derived(data.r.data);
	const monthlyNew = $derived(o ? o.discovery.slice(-24).map((r) => ({ x: r.month, y: r.artists })) : []);
</script>

<svelte:head><title>Rotor · Stats</title></svelte:head>

<div class="view">
	<Header title="Stats" />
	<StatsBar />
	{#if !o}
		<StatsError r={data.r} />
	{:else}
		<section class="section" aria-labelledby="h-totals">
			<div class="sec-h"><h2 id="h-totals">All time</h2></div>
			<div class="tiles">
				<StatTile label="Total plays" value={fmtInt(o.totals.plays)} />
				<StatTile label="Unique tracks" value={fmtInt(o.totals.uniqueTracks)} />
				<StatTile label="Unique artists" value={fmtInt(o.totals.uniqueArtists)} />
				<StatTile label="Hours" value={fmtInt(Math.round(o.totals.hours))} unit="h" />
				<StatTile label="Date range" value={o.totals.firstDay ? `${o.totals.firstDay.slice(0, 4)}–${o.totals.lastDay?.slice(0, 4)}` : '—'} small note={o.totals.firstDay ? `${o.totals.firstDay} → ${o.totals.lastDay}` : undefined} />
			</div>
		</section>

		<section class="section" aria-labelledby="h-streak">
			<div class="sec-h"><h2 id="h-streak">Streaks</h2></div>
			<div class="tiles">
				<StatTile label="Days listening" value={fmtInt(o.streaks.daysListening)} />
				<StatTile label="Current streak" value={fmtInt(o.streaks.current)} unit="days" />
				<StatTile label="Longest streak" value={fmtInt(o.streaks.longest)} unit="days" />
				<StatTile label="Avg plays / day" value={fmtInt(o.streaks.avgPerDay)} />
			</div>
		</section>

		<section class="section" aria-labelledby="h-monthly">
			<div class="sec-h"><h2 id="h-monthly">Monthly plays</h2></div>
			<BarChart points={o.monthly} label="Plays per month" xLabel={shortPeriod} />
		</section>

		<section class="section" aria-labelledby="h-new">
			<div class="sec-h"><h2 id="h-new">New artists per month</h2><span class="cap muted">last 24 months</span></div>
			<BarChart points={monthlyNew} label="New artists per month" unit="new artists" color="var(--chart-b)" xLabel={shortPeriod} />
			<p class="cap muted">
				{fmtInt(o.discovery.reduce((a, r) => a + r.artists, 0))} artists and {fmtInt(o.discovery.reduce((a, r) => a + r.tracks, 0))} tracks discovered in total.
			</p>
		</section>

		<section class="section" aria-labelledby="h-fp">
			<div class="sec-h"><h2 id="h-fp">Listening fingerprint</h2></div>
			<div class="tiles">
				<StatTile label="Peak hour" value={o.fingerprint.peakHour === null ? '—' : `${String(o.fingerprint.peakHour).padStart(2, '0')}:00`} />
				<StatTile label="Peak weekday" value={o.fingerprint.peakWeekday === null ? '—' : WEEKDAYS_SUN[o.fingerprint.peakWeekday]!} small />
				<StatTile label="Avg per listening day" value={String(o.fingerprint.avgPerListeningDay)} />
			</div>
		</section>
		<p class="cap muted foot">Updated {fmtDate(o.refreshedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · refreshed after every ingest.</p>
	{/if}
</div>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
		gap: 10px;
	}
	.tiles :global(.tile) {
		width: auto;
	}
	.foot {
		margin-top: 24px;
	}
</style>
