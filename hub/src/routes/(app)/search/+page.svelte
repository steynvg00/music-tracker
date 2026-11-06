<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import KindBadge from '$lib/components/KindBadge.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtInt } from '$lib/shared/format';
	import { albumHref, artistHref, trackHref } from '$lib/shared/stats';

	let { data } = $props();
	let q = $state('');
	$effect.pre(() => {
		q = data.q;
	});
	const r = $derived(data.r?.data ?? null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => void goto(`/search?q=${encodeURIComponent(q.trim())}`, { keepFocus: true, noScroll: true, replaceState: true }), 250);
	}
	const empty = $derived(r && !r.tracks.length && !r.artists.length && !r.albums.length && !r.playlists.length);
</script>

<svelte:head><title>Rotor · Search</title></svelte:head>

<div class="view">
	<Header title="Search" />
	<form role="search" onsubmit={(e) => (e.preventDefault(), onInput())}>
		<label class="sr" for="q">Search your tracks, artists, albums and playlists</label>
		<input id="q" type="search" bind:value={q} oninput={onInput} placeholder="Your tracks, artists, albums, playlists" autocomplete="off" />
	</form>
	<p class="cap muted">Searches your own listening history and library, not the Spotify catalogue.</p>

	{#if data.r && !r}
		<StatsError r={data.r} />
	{:else if r}
		{#if empty}<p class="muted">Nothing in your history matches “{r.q}”.</p>{/if}
		{#if r.tracks.length}
			<section class="section">
				<div class="sec-h"><h2>Tracks</h2></div>
				<RankList label="Tracks matching {r.q}" source="Search “{r.q}”" rows={r.tracks.map((t, i) => ({ key: t.uri, rank: i + 1, title: t.name, href: trackHref(t.uri), subtitle: t.artist, value: `${fmtInt(t.plays)} plays`, uri: t.uri }))} />
			</section>
		{/if}
		{#if r.artists.length}
			<section class="section">
				<div class="sec-h"><h2>Artists</h2></div>
				<RankList label="Artists" source="Search" playable={false} rows={r.artists.map((a, i) => ({ key: a.id, rank: i + 1, title: a.name, href: artistHref(a.id), value: `${fmtInt(a.plays)} plays` }))} />
			</section>
		{/if}
		{#if r.albums.length}
			<section class="section">
				<div class="sec-h"><h2>Albums</h2></div>
				<RankList label="Albums" source="Search" playable={false} rows={r.albums.map((a, i) => ({ key: a.id, rank: i + 1, title: a.name, href: albumHref(a.id), subtitle: a.artist, value: `${fmtInt(a.plays)} plays` }))} />
			</section>
		{/if}
		{#if r.playlists.length}
			<section class="section">
				<div class="sec-h"><h2>Your playlists</h2></div>
				<ul class="pls">{#each r.playlists as p (p.id)}<li><a href="/playlist/{p.id}">{p.name}</a> <KindBadge kind={p.kind} isOwned={p.isOwned} /></li>{/each}</ul>
			</section>
		{/if}
	{/if}
</div>

<style>
	input {
		width: 100%;
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		padding: 12px 18px;
		font: inherit;
		font-size: 16px;
		margin: 4px 0 6px;
	}
	.pls {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.pls li {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.pls a {
		color: var(--text-1);
	}
</style>
