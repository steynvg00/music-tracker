<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import Art from '$lib/components/Art.svelte';
	import Attribution from '$lib/components/Attribution.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CatalogTrackRows from '$lib/components/catalog/CatalogTrackRows.svelte';
	import { ApiFailure, apiGet, describeFailure } from '$lib/player/api-client';
	import { player } from '$lib/stores/player.svelte';
	import { flags } from '$lib/stores/flags.svelte';
	import { fmtInt } from '$lib/shared/format';
	import { catalogArtistHref, fmtReleaseDate, STATE_LABEL, typeLabel, type CatalogAlbum } from '$lib/shared/catalog';

	/** Catalog album page (v0.90 beta): cover, full tracklist from Spotify (live, not stored), your state per track. */
	let { data } = $props();
	let mounted = $state(false);
	onMount(() => (mounted = true));
	let album = $state<CatalogAlbum | null>(null);
	let error = $state<string | null>(null);

	async function load(id: string) {
		error = null;
		try {
			album = await apiGet<CatalogAlbum>(`/api/catalog/album/${id}`);
		} catch (e) {
			error = e instanceof ApiFailure && e.status === 429 ? `Spotify is rate-limiting Rotor. Try again in ${e.retryAfterS ?? 'a few'} s.` : describeFailure(e);
		}
	}
	$effect(() => {
		const id = data.id;
		if (!mounted || !flags.artistPages) return;
		album = null;
		void load(id);
	});
	function playAll() {
		if (album) void player.playContext(`spotify:album:${album.id}`, album.name);
	}
</script>

<svelte:head><title>Rotor · {album?.name ?? 'Album'}</title></svelte:head>

<div class="view" data-testid="album-beta">
	<Header title="Album" />
	{#if !mounted}
		<div class="skel" style="height:120px;border-radius:12px"></div>
	{:else if !flags.artistPages}
		<p data-testid="beta-off">The Spotify catalog is part of Artist pages (beta), which is off on this device. <a href="/settings#h-exp">Settings › Experimental</a></p>
	{:else if error}
		<p class="err" role="alert">{error}</p>
		<button class="btn sec" onclick={() => load(data.id)}>Try again</button>
	{:else if !album}
		<div aria-busy="true" aria-label="Loading album" class="hd"><div class="skel" style="width:160px;height:160px;flex:none"></div><div class="lines"><div class="skel" style="height:26px;width:60%"></div><div class="skel" style="height:14px;width:40%"></div></div></div>
	{:else}
		<header class="hd">
			<Art src={album.cover} size={160} alt="" />
			<div class="lines">
				<span class="cap muted">{typeLabel(album)}</span>
				<h1 class="ttl" data-testid="album-name">{album.name}</h1>
				<p class="by">{#each album.artists as ar, i (ar.name + i)}{i ? ', ' : ''}{#if catalogArtistHref(ar.id)}<a href={catalogArtistHref(ar.id)}>{ar.name}</a>{:else}{ar.name}{/if}{/each}</p>
				<p class="cap">{fmtReleaseDate(album.date, album.precision)} · {fmtInt(album.total)} tracks · <span class="state {album.state}" data-testid="album-state">{STATE_LABEL[album.state]}{#if album.plays} · {fmtInt(album.plays)} plays{/if}</span></p>
				<div class="acts">
					<button class="btn pri" onclick={playAll}><Icon name="play" size={16} /> Play</button>
					<Attribution uri="spotify:album:{album.id}" />
				</div>
			</div>
		</header>
		<CatalogTrackRows tracks={album.tracks} albumId={album.id} albumName={album.name} showArtists testid="album-rows" />
	{/if}
</div>

<style>
	.hd {
		display: flex;
		gap: 16px;
		align-items: flex-end;
		margin: 4px 0 16px;
		flex-wrap: wrap;
	}
	.lines {
		flex: 1;
		min-width: 200px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ttl {
		font-size: 26px;
		font-weight: 800;
		margin: 0;
	}
	.by {
		margin: 0;
		color: var(--text-2);
	}
	.by a {
		color: var(--text-1);
	}
	.acts {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}
	.state.liked {
		color: var(--accent);
	}
	.state.played {
		color: var(--success);
	}
	.err {
		color: var(--danger);
	}
	p {
		margin: 0;
	}
</style>
