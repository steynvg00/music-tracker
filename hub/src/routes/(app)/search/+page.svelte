<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import KindBadge from '$lib/components/KindBadge.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtInt } from '$lib/shared/format';
	import { albumHref, artistHref, trackHref } from '$lib/shared/stats';
	import { onMount } from 'svelte';
	import CatalogSearch from '$lib/components/catalog/CatalogSearch.svelte';
	import { flags } from '$lib/stores/flags.svelte';

	let { data } = $props();
	let q = $state('');
	$effect.pre(() => {
		q = data.q;
	});
	const r = $derived(data.r?.data ?? null);
	let mounted = $state(false);
	onMount(() => (mounted = true));
	// v0.90: the Spotify tab exists only with Artist pages (beta) on for this device.
	const spotifyTab = $derived(mounted && flags.artistPages);
	const src = $derived(spotifyTab && data.src === 'spotify' ? 'spotify' : 'mine');
	const href = (query: string, s: 'mine' | 'spotify') => `/search?q=${encodeURIComponent(query)}${s === 'spotify' ? '&src=spotify' : ''}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(() => void goto(href(q.trim(), src), { keepFocus: true, noScroll: true, replaceState: true }), 250);
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
	{#if spotifyTab}
		<div class="tabs" role="tablist" aria-label="Search source">
			<a role="tab" aria-selected={src === 'mine'} class:on={src === 'mine'} href={href(q.trim(), 'mine')} data-testid="tab-mine" data-sveltekit-replacestate>Your history</a>
			<a role="tab" aria-selected={src === 'spotify'} class:on={src === 'spotify'} href={href(q.trim(), 'spotify')} data-testid="tab-spotify" data-sveltekit-replacestate>Spotify</a>
		</div>
	{/if}
	{#if src === 'spotify'}
		<CatalogSearch q={data.q} />
	{:else}
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
	.tabs {
		display: inline-flex;
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 3px;
		margin: 6px 0 10px;
	}
	.tabs a {
		padding: 7px 16px;
		border-radius: var(--r-pill);
		font-size: 13px;
		font-weight: 700;
		color: var(--text-2);
	}
	.tabs a.on {
		background: var(--surface-4);
		color: var(--text-1);
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
