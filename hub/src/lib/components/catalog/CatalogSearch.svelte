<script lang="ts">
	import Art from '$lib/components/Art.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { ApiFailure, apiGet, describeFailure } from '$lib/player/api-client';
	import { player } from '$lib/stores/player.svelte';
	import { fmtInt, fmtTime } from '$lib/shared/format';
	import { catalogAlbumHref, catalogArtistHref, typeLabel, type CatalogSearchResults, type SearchType } from '$lib/shared/catalog';

	/**
	 * Search › Spotify (v0.90 beta): the Spotify catalog, 10 results per type per request (Spotify's
	 * cap since Feb 2026), "Load more" fetches the next 10 of that type. Live, nothing stored.
	 */
	let { q }: { q: string } = $props();
	let res = $state<CatalogSearchResults | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<SearchType | 'all' | null>(null);
	let gen = 0;

	const fail = (e: unknown) =>
		e instanceof ApiFailure && e.status === 429 ? `Spotify is rate-limiting Rotor. Try again in ${e.retryAfterS ?? 'a few'} s.` : describeFailure(e);

	$effect(() => {
		const query = q.trim();
		const my = ++gen;
		res = null;
		error = null;
		if (query.length < 2) return;
		busy = 'all';
		apiGet<CatalogSearchResults>(`/api/catalog/search?q=${encodeURIComponent(query)}`)
			.then((r) => my === gen && (res = r))
			.catch((e) => my === gen && (error = fail(e)))
			.finally(() => my === gen && (busy = null));
	});

	async function more(type: SearchType) {
		if (!res) return;
		const key = type === 'artist' ? 'artists' : type === 'album' ? 'albums' : 'tracks';
		const cur = res[key];
		if (!cur || cur.next === null) return;
		busy = type;
		const my = gen;
		try {
			const r = await apiGet<CatalogSearchResults>(`/api/catalog/search?q=${encodeURIComponent(res.q)}&type=${type}&offset=${cur.next}`);
			if (my !== gen || !res) return;
			const add = r[key];
			if (add) res = { ...res, [key]: { ...add, items: [...cur.items, ...add.items] } };
		} catch (e) {
			error = fail(e);
		} finally {
			busy = null;
		}
	}
	const empty = $derived(res && !res.artists?.items.length && !res.albums?.items.length && !res.tracks?.items.length);
</script>

<div data-testid="catalog-search">
	{#if q.trim().length < 2}
		<p class="cap muted">Type at least two characters to search the Spotify catalog.</p>
	{:else if error}
		<p class="err" role="alert">{error}</p>
	{:else if !res}
		<div aria-busy="true" aria-label="Searching Spotify">{#each [1, 2, 3, 4] as i (i)}<div class="srow"><div class="skel" style="width:48px;height:48px;flex:none"></div><div class="skel" style="height:14px;width:50%"></div></div>{/each}</div>
	{:else}
		{#if empty}<p class="muted">Nothing on Spotify matches “{res.q}”.</p>{/if}
		{#if res.artists?.items.length}
			<section class="section" data-testid="cs-artists">
				<div class="sec-h"><h2>Artists</h2><span class="cap muted">{fmtInt(res.artists.items.length)} of {fmtInt(res.artists.total)}</span></div>
				<ul class="list">
					{#each res.artists.items as a (a.id)}
						<li><a class="item" href={catalogArtistHref(a.id)} data-testid="cs-artist"><Art src={a.image} size={48} shape="circle" alt="" /><span class="ell">{a.name}</span></a></li>
					{/each}
				</ul>
				{#if res.artists.next !== null}<button class="btn sec more" disabled={busy === 'artist'} onclick={() => more('artist')} data-testid="more-artist">{busy === 'artist' ? 'Loading…' : 'Load more'}</button>{/if}
			</section>
		{/if}
		{#if res.albums?.items.length}
			<section class="section" data-testid="cs-albums">
				<div class="sec-h"><h2>Albums</h2><span class="cap muted">{fmtInt(res.albums.items.length)} of {fmtInt(res.albums.total)}</span></div>
				<ul class="list">
					{#each res.albums.items as al (al.id)}
						<li>
							<a class="item" href={catalogAlbumHref(al.id)} data-testid="cs-album"><Art src={al.cover} size={48} alt="" />
								<span class="grow"><span class="ell" style="display:block">{al.name}</span><span class="sub ell" style="display:block">{al.type ? typeLabel({ type: al.type, total: 0 }) : 'Release'} · {al.date?.slice(0, 4) ?? '—'} · {al.artists.map((x) => x.name).join(', ')}</span></span>
							</a>
						</li>
					{/each}
				</ul>
				{#if res.albums.next !== null}<button class="btn sec more" disabled={busy === 'album'} onclick={() => more('album')} data-testid="more-album">{busy === 'album' ? 'Loading…' : 'Load more'}</button>{/if}
			</section>
		{/if}
		{#if res.tracks?.items.length}
			<section class="section" data-testid="cs-tracks">
				<div class="sec-h"><h2>Tracks</h2><span class="cap muted">{fmtInt(res.tracks.items.length)} of {fmtInt(res.tracks.total)}</span></div>
				<ul class="list">
					{#each res.tracks.items as t, i (t.id + i)}
						<li class="trow" data-testid="cs-track">
							<button class="ibtn sm" aria-label="Play {t.name}" onclick={() => player.play({ type: 'play', body: { uris: [t.uri] }, label: t.name })}><Icon name="play" size={16} /></button>
							<span class="grow">
								<span class="ell" style="display:block">{t.name}</span>
								<span class="sub ell" style="display:block">
									{#each t.artists as a, j (a.name + j)}{j ? ', ' : ''}{#if catalogArtistHref(a.id)}<a href={catalogArtistHref(a.id)}>{a.name}</a>{:else}{a.name}{/if}{/each}
									{#if t.album.id} · <a href={catalogAlbumHref(t.album.id)}>{t.album.name}</a>{/if}
								</span>
							</span>
							<span class="sub tab-num">{t.plays ? `${fmtInt(t.plays)} plays` : 'not heard'}</span>
							<span class="sub tab-num">{t.durationMs ? fmtTime(t.durationMs) : ''}</span>
						</li>
					{/each}
				</ul>
				{#if res.tracks.next !== null}<button class="btn sec more" disabled={busy === 'track'} onclick={() => more('track')} data-testid="more-track">{busy === 'track' ? 'Loading…' : 'Load more'}</button>{/if}
			</section>
		{/if}
		<p class="cap muted">Results from Spotify. Plays are your own data.</p>
	{/if}
</div>

<style>
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
		color: var(--text-1);
		min-width: 0;
	}
	.trow {
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.sub {
		font-size: 13px;
		color: var(--text-2);
		flex: none;
	}
	.grow .sub a {
		color: inherit;
	}
	.ibtn.sm {
		width: 36px;
		height: 36px;
		flex: none;
	}
	.more {
		margin-top: 8px;
	}
	.srow {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
	}
	.err {
		color: var(--danger);
	}
</style>
