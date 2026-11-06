<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt, openInSpotify } from '$lib/shared/format';
	import { artistHref, trackHref } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';

	let { data } = $props();
	const a = $derived(data.r.data);
	const spotifyUrl = $derived(a ? openInSpotify(`spotify:album:${a.id}`) : null);
</script>

<svelte:head><title>Rotor · {a?.name ?? 'Album'}</title></svelte:head>

<div class="view">
	<Header title="Album" />
	{#if !a}
		<StatsError r={data.r} />
	{:else}
		<header class="hd">
			<h1 class="ttl">{a.name}</h1>
			<p class="by">{#each a.artists as ar, i (ar.name + i)}{i ? ', ' : ''}{#if artistHref(ar.id)}<a href={artistHref(ar.id)}>{ar.name}</a>{:else}{ar.name}{/if}{/each}{#if a.releaseDate}<span class="muted"> · {a.releaseDate}</span>{/if}</p>
			{#if spotifyUrl}<a class="btn sec" href={spotifyUrl} target="_blank" rel="noopener">Open Spotify</a>{/if}
		</header>
		<div class="tiles">
			<StatTile label="Plays" value={fmtInt(a.metrics.plays)} />
			<StatTile label="Tracks played" value={fmtInt(a.metrics.uniqueTracks)} />
			<StatTile label="First play" value={fmtDate(a.metrics.firstPlayedAt)} small />
			<StatTile label="Last play" value={fmtDate(a.metrics.lastPlayedAt)} small />
		</div>
		<section class="section">
			<div class="sec-h"><h2>Plays per month</h2></div>
			<BarChart points={a.perMonth} label="Plays per month of {a.name}" xLabel={shortPeriod} height={120} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Tracks</h2><span class="cap muted">plays include single and album versions</span></div>
			<RankList
				label={a.name}
				source="Album › {a.name}"
				rows={a.tracks.map((t, i) => ({ key: t.uri, rank: i + 1, title: t.name, href: trackHref(t.uri), value: `${fmtInt(t.plays)} plays${t.variants > 1 ? ` · ${t.variants} versions` : ''}`, uri: t.uri }))}
			/>
		</section>
	{/if}
</div>

<style>
	.hd {
		margin: 4px 0 16px;
	}
	.ttl {
		font-size: 26px;
		font-weight: 800;
		margin: 0;
	}
	.by {
		color: var(--text-2);
		margin: 6px 0 10px;
	}
	.by a {
		color: var(--text-1);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 10px;
	}
	.tiles :global(.tile) {
		width: auto;
	}
</style>
