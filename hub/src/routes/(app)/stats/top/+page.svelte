<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsBar from '$lib/components/stats/StatsBar.svelte';
	import OptionSheet from '$lib/components/OptionSheet.svelte';
	import type { PillGroup } from '$lib/shared/pills';
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

	// v0.91: one pill bar. List (always one), period (All time = nothing selected), album mode;
	// Year and Custom range as ▾ menus; Rank by as the icon button at the end.
	let sheet = $state<null | 'year' | 'rank' | 'custom'>(null);
	const years = Array.from({ length: thisYear - 2014 }, (_, i) => thisYear - i);
	const ranged = $derived(view === 'tracks' || view === 'artists');
	const presetRange = $derived(d?.range.key === 'this_year' || d?.range.key === 'last_year' ? d.range.key : null);
	const barGroups = $derived<PillGroup[]>([
		{
			key: 'view',
			label: 'List',
			required: true,
			value: view,
			options: [
				{ value: 'tracks', label: 'Tracks' },
				{ value: 'artists', label: 'Artists' },
				{ value: 'albums', label: 'Albums' },
				{ value: 'race', label: 'Race' }
			]
		},
		{
			key: 'range',
			label: 'Period',
			hidden: !ranged,
			value: presetRange,
			options: [
				{ value: 'this_year', label: 'This year' },
				{ value: 'last_year', label: 'Last year' }
			]
		},
		{
			key: 'mode',
			label: 'Album depth',
			hidden: view !== 'albums',
			value: d?.mode === 'depth' ? 'depth' : null,
			options: [{ value: 'depth', label: 'Plays per track' }]
		}
	]);
	const barMenus = $derived(
		ranged
			? [
					{ key: 'year', label: d?.range.kind === 'year' ? d.range.label : 'Year', active: d?.range.kind === 'year', after: true, onclick: () => (sheet = 'year') },
					{ key: 'custom', label: d?.range.kind === 'range' ? d.range.label : 'Custom range', active: d?.range.kind === 'range', after: true, onclick: () => (sheet = 'custom') }
				]
			: []
	);
	const rankAction = $derived(
		ranged
			? { label: `Rank by: ${(view === 'tracks' ? TRACK_RANKS : ARTIST_RANKS)[(d?.rank ?? 'plays') as 'plays'].label}`, icon: 'sort' as const, onclick: () => (sheet = 'rank'), active: !!d?.rank && d.rank !== 'plays' }
			: undefined
	);
	function pickPill(group: string, value: string | null) {
		if (group === 'view') set({ view: value, rank: null });
		else if (group === 'range') set({ range: value });
		else if (group === 'mode') set({ mode: value });
	}
	function clearFilters() {
		set({ range: null, rank: null, mode: null });
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
	<StatsBar groups={barGroups} menus={barMenus} onpick={pickPill} onclear={clearFilters} action={rankAction} />
	{#if (view === 'tracks' || view === 'artists') && d?.rank && d.rank !== 'plays' && d.range.kind !== 'all'}
		<p class="cap muted">Score rankings use pre-computed all-time scores and ignore the time range. Pick “Total plays” to apply it.</p>
	{/if}

	<OptionSheet
		open={sheet === 'year'}
		onclose={() => (sheet = null)}
		title="Year"
		sections={[{ key: 'year', title: 'Year', options: years.map((y) => ({ value: `year-${y}`, label: String(y) })), value: d?.range.kind === 'year' ? d.range.key : null, onselect: (v) => set({ range: v }) }]}
	/>
	<OptionSheet
		open={sheet === 'rank'}
		onclose={() => (sheet = null)}
		title="Rank by"
		sections={[{ key: 'rank', title: 'Rank by', options: Object.entries(view === 'tracks' ? TRACK_RANKS : ARTIST_RANKS).map(([k, v]) => ({ value: k, label: v.label })), value: d?.rank ?? 'plays', onselect: (v) => set({ rank: v === 'plays' ? null : v }) }]}
	/>
	<OptionSheet open={sheet === 'custom'} onclose={() => (sheet = null)} title="Custom range" sections={[]}>
		<form class="custom" onsubmit={(e) => (e.preventDefault(), (sheet = null), set({ range: `range-${customStart}_${customEnd}` }))}>
			<label>From <input type="date" bind:value={customStart} /></label>
			<label>To <input type="date" bind:value={customEnd} /></label>
			<button class="btn pri" type="submit">Apply</button>
		</form>
	</OptionSheet>

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
	.custom {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: end;
		font-size: 13px;
		color: var(--text-2);
	}
	.custom label {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.custom input {
		background: var(--surface-3);
		border: 0;
		border-radius: 8px;
		padding: 9px 10px;
		color: var(--text-1);
		font: inherit;
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
