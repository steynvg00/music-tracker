<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import HBars from '$lib/components/stats/HBars.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsBar from '$lib/components/stats/StatsBar.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { Behaviour } from '$lib/server/stats/sections';
	import { fmtInt } from '$lib/shared/format';
	import { trackHref } from '$lib/shared/stats';

	let { data } = $props();
	const b = $derived(data.r.data as Behaviour | null);
	/** Spotify's reason_end codes, in words. */
	const REASONS: Record<string, string> = {
		trackdone: 'Played to the end',
		fwdbtn: 'Skipped (next)',
		backbtn: 'Went back',
		endplay: 'Stopped',
		logout: 'Logged out',
		remote: 'Changed on another device',
		clickrow: 'Picked another track',
		unexpected_exit: 'App closed',
		unexpected_exit_while_paused: 'App closed while paused',
		trackerror: 'Playback error',
		unknown: 'Unknown'
	};
</script>

<svelte:head><title>Rotor · Behaviour</title></svelte:head>

<div class="view">
	<Header title="Behaviour" />
	<StatsBar />
	{#if !b}
		<StatsError r={data.r} />
	{:else}
		<div class="tiles">
			<StatTile label="Total plays" value={fmtInt(b.overview.plays)} />
			<StatTile label="Total hours" value={fmtInt(Math.round(b.overview.hours))} unit="h" />
			<StatTile label="Distinct tracks" value={fmtInt(b.overview.distinctTracks)} />
			<StatTile label="Skip rate" value={`${b.skipRatePct}%`} note="ended with ‘next’" />
			<StatTile label="Shuffle rate" value={`${b.shuffleRatePct}%`} />
		</div>
		<section class="section">
			<div class="sec-h"><h2>Listening time per year</h2></div>
			<BarChart points={b.hoursByYear.map((r) => ({ x: String(r.year), y: r.hours }))} label="Hours per year" unit="hours" />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Where you listen</h2></div>
			<HBars label="Plays by platform" suffix="" rows={b.platforms.map((p) => ({ label: p.family, value: p.plays, note: `${p.pct}%` }))} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Shuffle per year</h2></div>
			<HBars label="Shuffle rate per year" suffix="%" rows={b.shuffleByYear.map((s) => ({ label: String(s.year), value: s.pct }))} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>How plays end</h2></div>
			<HBars label="End-of-play reasons" rows={b.endReasons.map((r) => ({ label: REASONS[r.reason] ?? r.reason, value: r.plays, note: `${r.pct}%` }))} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Most skipped</h2><span class="cap muted">tracks with ≥ 10 plays</span></div>
			<RankList
				label="Most skipped tracks"
				source="Stats › Behaviour"
				playable={false}
				rows={b.mostSkipped.map((t, i) => ({ key: t.uri, rank: i + 1, title: t.track, href: trackHref(t.uri), subtitle: t.artist, value: `${t.skipRatePct}% · ${t.skips}/${t.plays}` }))}
			/>
		</section>
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
</style>
