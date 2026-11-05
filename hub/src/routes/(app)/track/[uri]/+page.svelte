<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import KindBadge from '$lib/components/KindBadge.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import BadgeGrid from '$lib/components/stats/BadgeGrid.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import HBars from '$lib/components/stats/HBars.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { fmtDate, fmtDuration, fmtInt, openInSpotify } from '$lib/shared/format';
	import { albumHref, artistHref, trackHref } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';

	let { data } = $props();
	const t = $derived(data.r.data);
	const spotifyUrl = $derived(t ? openInSpotify(t.canonicalUri) : null);
</script>

<svelte:head><title>Rotor · {t?.name ?? 'Track'}</title></svelte:head>

<div class="view">
	<Header title="Track" />
	{#if !t}
		<StatsError r={data.r} />
	{:else}
		<header class="hd">
			<h1 class="ttl">{t.name}</h1>
			<p class="by">
				{#each t.artists as a, i (a.name + i)}{i ? ', ' : ''}{#if artistHref(a.id)}<a href={artistHref(a.id)}>{a.name}</a>{:else}{a.name}{/if}{/each}
				{#if t.album.name}<span class="muted"> · </span>{#if albumHref(t.album.id)}<a href={albumHref(t.album.id)}>{t.album.name}</a>{:else}{t.album.name}{/if}{/if}
			</p>
			<p class="cap muted">
				{#if t.releaseDate}Released {t.releaseDate} · {/if}{#if t.durationMs}{fmtDuration(t.durationMs)} · {/if}{t.liked ? '♥ In your Liked Songs' : 'Not in Liked Songs'}
			</p>
			<div class="acts">
				<button class="btn pri" onclick={() => player.play({ type: 'play', body: { uris: [t.canonicalUri] }, label: t.name })}><Icon name="play" size={16} /> Play</button>
				{#if spotifyUrl}<a class="btn sec" href={spotifyUrl} target="_blank" rel="noopener">Open Spotify</a>{/if}
			</div>
		</header>

		<div class="tiles">
			<StatTile label="Plays" value={fmtInt(t.metrics.plays)} />
			<StatTile label="First play" value={fmtDate(t.metrics.firstPlayedAt)} small />
			<StatTile label="Last play" value={fmtDate(t.metrics.lastPlayedAt)} small />
			<StatTile label="Days listened" value={fmtInt(t.metrics.daysListened)} />
			<StatTile label="Skip rate" value={`${t.metrics.skipRatePct}%`} />
			<StatTile label="Completion" value={`${t.metrics.completionPct}%`} note="played to the end" />
		</div>

		<section class="section">
			<div class="sec-h"><h2>Plays per month</h2></div>
			<BarChart points={t.perMonth} label="Plays per month of {t.name}" xLabel={shortPeriod} height={120} />
		</section>

		<section class="section">
			<div class="sec-h"><h2>Badges</h2></div>
			<BadgeGrid categories={t.badges} />
		</section>

		{#if t.heardAlongside.length}
			<section class="section">
				<div class="sec-h"><h2>Usually heard alongside</h2><span class="cap muted">within 30 minutes</span></div>
				<RankList
					label="Heard alongside {t.name}"
					source="Track › {t.name} › heard alongside"
					rows={t.heardAlongside.map((h, i) => ({ key: h.uri, rank: i + 1, title: h.name, href: trackHref(h.uri), subtitle: h.artist, value: `${fmtInt(h.together)}×`, uri: h.uri }))}
				/>
			</section>
		{/if}

		{#if t.moreFromArtist.length}
			<section class="section">
				<div class="sec-h"><h2>More from {t.artists[0]?.name ?? 'this artist'}</h2></div>
				<RankList label="More from {t.artists[0]?.name}" source="Track › more from artist" rows={t.moreFromArtist.map((m, i) => ({ key: m.uri, rank: i + 1, title: m.name, href: trackHref(m.uri), value: `${fmtInt(m.plays)} plays`, uri: m.uri }))} />
			</section>
		{/if}

		{#if t.endReasons.length}
			<section class="section">
				<div class="sec-h"><h2>How plays ended</h2></div>
				<HBars label="End reasons" rows={t.endReasons.map((r) => ({ label: r.reason, value: r.plays, note: `${r.pct}%` }))} />
			</section>
		{/if}

		{#if t.variants.length > 1}
			<section class="section">
				<div class="sec-h"><h2>Versions of this recording</h2><span class="cap muted">same ISRC{t.isrc ? ` ${t.isrc}` : ''}, plays counted together</span></div>
				<ul class="vars">
					{#each t.variants as v (v.uri)}
						<li><span class="ell">{v.albumName ?? v.uri}</span><span class="cap muted">{v.albumType ?? ''}{v.releaseDate ? ` · ${v.releaseDate}` : ''}{v.canonical ? ' · canonical' : ''}</span><span class="tab-num">{fmtInt(v.plays)}</span></li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if t.inPlaylists.length}
			<section class="section">
				<div class="sec-h"><h2>In your playlists</h2></div>
				<ul class="pls">
					{#each t.inPlaylists as p (p.id)}<li><a href="/playlist/{p.id}">{p.name}</a> <KindBadge kind={p.kind} isOwned={true} /></li>{/each}
				</ul>
			</section>
		{/if}
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
		overflow-wrap: anywhere;
	}
	.by {
		margin: 6px 0 4px;
		color: var(--text-2);
	}
	.by a {
		color: var(--text-1);
	}
	.acts {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 10px;
	}
	.tiles :global(.tile) {
		width: auto;
	}
	.vars,
	.pls {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.vars li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 10px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
	}
	.pls li {
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.pls a {
		color: var(--text-1);
	}
</style>
