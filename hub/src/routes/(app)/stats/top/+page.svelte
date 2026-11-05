<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsNav from '$lib/components/stats/StatsNav.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtInt } from '$lib/shared/format';
	import {
		ARTIST_RANKS,
		TRACK_RANKS,
		albumHref,
		artistHref,
		fmtScore,
		trackHref,
		type ArtistRank,
		type RankRow,
		type RankedAlbum,
		type RankedArtist,
		type RankedTrack,
		type StatsRange,
		type TrackRank
	} from '$lib/shared/stats';

	type TopData = {
		view: 'tracks' | 'artists' | 'albums' | 'race';
		range: StatsRange;
		rank?: TrackRank | ArtistRank;
		mode?: 'plays' | 'depth';
		tracks?: RankedTrack[];
		artists?: RankedArtist[];
		albums?: RankedAlbum[];
		race?: { years: number[]; artists: { name: string; ranks: (number | null)[]; plays: number[] }[] };
	};

	let { data } = $props();
	const d = $derived(data.r.data as TopData | null);
	const q = $derived(page.url.searchParams);
	const view = $derived(d?.view ?? 'tracks');
	const thisYear = new Date().getFullYear();
	let customStart = $state('2024-01-01');
	let customEnd = $state(new Date().toISOString().slice(0, 10));

	function set(params: Record<string, string | null>) {
		const u = new URL(page.url);
		for (const [k, v] of Object.entries(params)) {
			if (v === null) u.searchParams.delete(k);
			else u.searchParams.set(k, v);
		}
		void goto(u.pathname + u.search, { keepFocus: true, noScroll: true });
	}

	const trackRows = $derived<RankRow[]>(
		(d?.tracks ?? []).map((t) => ({
			key: t.uri ?? `${t.rank}`,
			rank: t.rank,
			title: t.name,
			href: trackHref(t.uri),
			subtitle: t.artist,
			subHref: artistHref(t.artistId),
			value: d?.rank && d.rank !== 'plays' ? `${fmtScore(d.rank, t.score ?? null)} · ${fmtInt(t.plays)} plays` : `${fmtInt(t.plays)} plays`,
			uri: t.uri
		}))
	);
	const artistRows = $derived<RankRow[]>(
		(d?.artists ?? []).map((a) => ({
			key: a.name,
			rank: a.rank,
			title: a.name,
			href: artistHref(a.id),
			value: d?.rank && d.rank !== 'plays' ? `${fmtScore(d.rank, a.score ?? null)} · ${fmtInt(a.plays)} plays` : `${fmtInt(a.plays)} plays`
		}))
	);
	const albumRows = $derived<RankRow[]>(
		(d?.albums ?? []).map((a) => ({
			key: `${a.name}|${a.artist}`,
			rank: a.rank,
			title: a.name,
			href: albumHref(a.albumId),
			subtitle: a.artist,
			value: d?.mode === 'depth' ? `${a.playsPerTrack} plays/track · ${a.uniqueTracks} tracks` : `${fmtInt(a.plays)} plays · ${a.uniqueTracks} tracks`
		}))
	);
</script>

<svelte:head><title>Rotor · Top</title></svelte:head>

<div class="view">
	<Header title="Top" />
	<StatsNav />

	<div class="filters" role="group" aria-label="List">
		{#each [['tracks', 'Tracks'], ['artists', 'Artists'], ['albums', 'Albums'], ['race', 'Race']] as const as [k, l] (k)}
			<button class="chip" class:on={view === k} aria-pressed={view === k} onclick={() => set({ view: k, rank: null })}>{l}</button>
		{/each}
	</div>

	{#if view === 'tracks' || view === 'artists'}
		<div class="filters" role="group" aria-label="Time range">
			{#each [['all', 'All time'], ['this_year', 'This year'], ['last_year', 'Last year']] as const as [k, l] (k)}
				<button class="chip" class:on={(d?.range.key ?? 'all') === k} aria-pressed={(d?.range.key ?? 'all') === k} onclick={() => set({ range: k })}>{l}</button>
			{/each}
			<label class="chip sel">
				<span class="sr">Year</span>
				<select value={d?.range.kind === 'year' ? d.range.key : ''} onchange={(e) => e.currentTarget.value && set({ range: e.currentTarget.value })}>
					<option value="">Year…</option>
					{#each Array.from({ length: thisYear - 2014 }, (_, i) => thisYear - i) as y (y)}<option value="year-{y}">{y}</option>{/each}
				</select>
			</label>
		</div>
		<details class="custom" open={d?.range.kind === 'range'}>
			<summary>Custom range{d?.range.kind === 'range' ? `: ${d.range.label}` : ''}</summary>
			<form onsubmit={(e) => (e.preventDefault(), set({ range: `range-${customStart}_${customEnd}` }))}>
				<label>From <input type="date" bind:value={customStart} /></label>
				<label>To <input type="date" bind:value={customEnd} /></label>
				<button class="btn sec" type="submit">Apply</button>
			</form>
		</details>
		<label class="rank">
			Rank by
			<select value={d?.rank ?? 'plays'} onchange={(e) => set({ rank: e.currentTarget.value })}>
				{#each Object.entries(view === 'tracks' ? TRACK_RANKS : ARTIST_RANKS) as [k, v] (k)}<option value={k}>{v.label}</option>{/each}
			</select>
		</label>
		{#if d?.rank && d.rank !== 'plays' && d.range.kind !== 'all'}
			<p class="cap muted">Score rankings use pre-computed all-time scores and ignore the time range. Pick “Total plays” to apply it.</p>
		{/if}
	{:else if view === 'albums'}
		<div class="filters" role="group" aria-label="Album depth">
			<button class="chip" class:on={d?.mode !== 'depth'} aria-pressed={d?.mode !== 'depth'} onclick={() => set({ mode: 'plays' })}>Total plays</button>
			<button class="chip" class:on={d?.mode === 'depth'} aria-pressed={d?.mode === 'depth'} onclick={() => set({ mode: 'depth' })}>Plays per track</button>
		</div>
	{/if}

	{#if !d}
		<StatsError r={data.r} />
	{:else if view === 'tracks'}
		<section class="section"><div class="sec-h"><h2>Top 50 tracks · {d.range.label}</h2></div>
			<RankList rows={trackRows} label="Top tracks · {d.range.label}" source="Stats › Top tracks · {d.range.label}" />
		</section>
	{:else if view === 'artists'}
		<section class="section"><div class="sec-h"><h2>Top 50 artists · {d.range.label}</h2></div>
			<RankList rows={artistRows} label="Top artists" source="Stats › Top artists" playable={false} />
		</section>
	{:else if view === 'albums'}
		<section class="section"><div class="sec-h"><h2>Album depth</h2></div>
			<p class="cap muted">Track counts include album and single versions as separate entries.</p>
			<RankList rows={albumRows} label="Album depth" source="Stats › Albums" playable={false} />
		</section>
	{:else if view === 'race' && d.race}
		<section class="section"><div class="sec-h"><h2>Artist rank race</h2><span class="cap muted">your 10 biggest artists, their rank per year</span></div>
			<div class="race">
				<table>
					<thead><tr><th scope="col">Artist</th>{#each d.race.years as y (y)}<th scope="col">{y}</th>{/each}</tr></thead>
					<tbody>
						{#each d.race.artists as a (a.name)}
							<tr><th scope="row">{a.name}</th>{#each a.ranks as r, i (i)}<td class:top={r === 1} title="{fmtInt(a.plays[i] ?? 0)} plays">{r ? `#${r}` : '—'}</td>{/each}</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 10px;
	}
	.chip {
		padding: 7px 14px;
		min-height: 36px;
		border-radius: var(--r-pill);
		background: var(--surface-2);
		color: var(--text-2);
		font-size: 13px;
		font-weight: 600;
	}
	.chip.on {
		background: var(--accent-subtle);
		color: var(--text-1);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.chip.sel select,
	.rank select,
	.custom input {
		background: transparent;
		color: inherit;
		border: 0;
		font: inherit;
	}
	.rank {
		display: inline-flex;
		gap: 8px;
		align-items: center;
		font-size: 13px;
		color: var(--text-2);
		margin-bottom: 6px;
	}
	.rank select,
	.custom input {
		background: var(--surface-2);
		border-radius: 8px;
		padding: 7px 10px;
		color: var(--text-1);
	}
	.custom {
		margin-bottom: 10px;
		font-size: 13px;
		color: var(--text-2);
	}
	.custom form {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: end;
		margin-top: 8px;
	}
	.custom label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.race {
		overflow-x: auto;
	}
	.race table {
		border-collapse: collapse;
		font-size: 13px;
	}
	.race th,
	.race td {
		padding: 6px 10px;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	.race td {
		color: var(--text-2);
		text-align: right;
	}
	.race td.top {
		color: var(--text-1);
		font-weight: 800;
	}
</style>
