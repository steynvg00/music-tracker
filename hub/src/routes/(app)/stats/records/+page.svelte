<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsNav from '$lib/components/stats/StatsNav.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { Records } from '$lib/server/stats/sections';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { ordinal } from '$lib/shared/stats';

	let { data } = $props();
	const r = $derived(data.r.data as Records | null);
	const gap = $derived(r?.longestGap ? { days: Math.floor(r.longestGap.ms / 86_400_000), hours: Math.floor((r.longestGap.ms % 86_400_000) / 3_600_000) } : null);
	const a = $derived(r?.achievements);
</script>

<svelte:head><title>Rotor · Records</title></svelte:head>

<div class="view">
	<Header title="Records" />
	<StatsNav />
	{#if !r || !a}
		<StatsError r={data.r} />
	{:else}
		<section class="section">
			<div class="sec-h"><h2>Achievements</h2></div>
			<div class="tiles">
				<StatTile label="First play" value={a.firstPlay ?? '—'} small />
				<StatTile label="Longest streak" value={a.longestStreak ? fmtInt(a.longestStreak.len) : '—'} unit="days" note={a.longestStreak ? `${a.longestStreak.start} → ${a.longestStreak.end}` : undefined} />
				<StatTile label="Top artist ever" value={a.topArtist?.name ?? '—'} small note={a.topArtist ? `${fmtInt(a.topArtist.plays)} plays` : undefined} />
				<StatTile label="Top track ever" value={a.topTrack?.track ?? '—'} small note={a.topTrack ? `${a.topTrack.artist} · ${fmtInt(a.topTrack.plays)} plays` : undefined} />
				<StatTile label="Biggest year" value={a.biggestYear ? String(a.biggestYear.year) : '—'} note={a.biggestYear ? `${fmtInt(a.biggestYear.plays)} plays` : undefined} />
				<StatTile label="Best discovery year" value={a.bestDiscoveryYear ? String(a.bestDiscoveryYear.year) : '—'} note={a.bestDiscoveryYear ? `${fmtInt(a.bestDiscoveryYear.artists)} new artists` : undefined} />
				<StatTile label="Peak hour" value={a.peakHour ? `${String(a.peakHour.hour).padStart(2, '0')}:00` : '—'} note={a.peakHour ? `${fmtInt(a.peakHour.plays)} plays` : undefined} />
			</div>
		</section>

		{#if r.biggestDay}
			<section class="section">
				<div class="sec-h"><h2>Biggest single day</h2><span class="cap muted">{fmtDate(`${r.biggestDay.day}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {fmtInt(r.biggestDay.plays)} plays</span></div>
				<RankList label="Most played that day" source="Stats › Records" playable={false} rows={r.biggestDay.top.map((t, i) => ({ key: `${t.artist}|${t.track}`, rank: i + 1, title: t.track, subtitle: t.artist, value: `${fmtInt(t.plays)}×` }))} />
			</section>
		{/if}

		{#if r.longestGap && gap}
			<section class="section">
				<div class="sec-h"><h2>Longest gap</h2><span class="cap muted">{fmtInt(gap.days)} days, {gap.hours} hours of silence</span></div>
				<dl class="gap">
					<dt>Last before</dt><dd>{fmtDate(r.longestGap.lastBefore.at, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.longestGap.lastBefore.track} — {r.longestGap.lastBefore.artist}</dd>
					<dt>First after</dt><dd>{fmtDate(r.longestGap.firstAfter.at, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · {r.longestGap.firstAfter.track} — {r.longestGap.firstAfter.artist}</dd>
				</dl>
			</section>
		{/if}

		<section class="section">
			<div class="sec-h"><h2>Milestones</h2></div>
			<RankList label="Play milestones" source="Stats › Records" playable={false} rows={r.milestones.map((m) => ({ key: String(m.n), rank: undefined, title: `${ordinal(m.n)} play`, subtitle: `${m.track} — ${m.artist}`, value: fmtDate(m.at) }))} />
		</section>

		<section class="section">
			<div class="sec-h"><h2>Top artist of each year</h2></div>
			<RankList label="Top artist per year" source="Stats › Records" playable={false} rows={r.topArtistPerYear.map((t) => ({ key: String(t.year), rank: t.year, title: t.artist, value: `${fmtInt(t.plays)} plays` }))} />
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
	.gap {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 6px 14px;
		margin: 0;
		font-size: 14px;
	}
	dt {
		color: var(--text-3);
	}
	dd {
		margin: 0;
	}
</style>
