<script lang="ts">
	import Art from '$lib/components/Art.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CatalogTrackRows from './CatalogTrackRows.svelte';
	import { apiGet, describeFailure } from '$lib/player/api-client';
	import { catalogAlbumHref, fmtReleaseDate, myState, STATE_LABEL, typeLabel, type CatalogAlbum, type CatalogTrack, type ReleaseWithState } from '$lib/shared/catalog';
	import { fmtInt } from '$lib/shared/format';

	/**
	 * One release on the Artist page (beta). Own releases expand to their full tracklist. "Appears on"
	 * releases show ONLY this artist's tracks underneath (loaded as the card scrolls into view, cached
	 * server-side) and "Show full album" expands the whole tracklist. Full tracklists are fetched live
	 * from Spotify when expanded and never stored.
	 */
	let {
		release,
		artist,
		own = undefined,
		ownError = false,
		onvisible
	}: {
		release: ReleaseWithState;
		artist: { id: string; name: string };
		own?: CatalogTrack[] | undefined;
		ownError?: boolean;
		onvisible?: (id: string) => void;
	} = $props();

	const appears = $derived(release.group === 'appears_on');
	let open = $state(false);
	let full = $state<CatalogAlbum | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let el = $state<HTMLElement | null>(null);

	// Appears on: your state also counts plays of this artist's tracks on it (any version).
	const ownPlays = $derived(own?.reduce((n, t) => n + t.plays, 0) ?? 0);
	const plays = $derived(Math.max(release.plays, ownPlays));
	const liked = $derived(release.liked || !!own?.some((t) => t.liked));
	const mine = $derived(myState(plays, liked));

	$effect(() => {
		if (!appears || !el || own !== undefined || !onvisible) return;
		const node = el;
		if (typeof IntersectionObserver === 'undefined') {
			onvisible(release.id);
			return;
		}
		const io = new IntersectionObserver(
			(es) => {
				if (es.some((e) => e.isIntersecting)) {
					onvisible(release.id);
					io.disconnect();
				}
			},
			{ rootMargin: '600px 0px' }
		);
		io.observe(node);
		return () => io.disconnect();
	});

	async function toggle() {
		open = !open;
		if (!open || full || loading) return;
		loading = true;
		error = null;
		try {
			full = await apiGet<CatalogAlbum>(`/api/catalog/album/${release.id}`);
		} catch (e) {
			error = describeFailure(e);
			open = false;
		} finally {
			loading = false;
		}
	}
</script>

<article class="rel" bind:this={el} data-testid="release" data-id={release.id} data-group={release.group} data-date={release.date ?? ''} data-state={mine}>
	<div class="head">
		<a class="cover" href={catalogAlbumHref(release.id)} aria-label="Open {release.name}"><Art src={release.cover} size={64} alt="" /></a>
		<div class="meta">
			<a class="name ell" href={catalogAlbumHref(release.id)} title={release.name}>{release.name}</a>
			<span class="sub">{fmtReleaseDate(release.date, release.precision)} · {typeLabel(release)} · {fmtInt(release.total)} track{release.total === 1 ? '' : 's'}</span>
			<span class="state {mine}" data-testid="release-state">{STATE_LABEL[mine]}{#if plays} · {fmtInt(plays)} plays{/if}</span>
		</div>
		{#if !appears}
			<button class="btn ghost sm" aria-expanded={open} onclick={toggle} data-testid="expand">{open ? 'Hide tracks' : 'Tracks'} <Icon name="down" size={14} /></button>
		{/if}
	</div>

	{#if appears}
		<div class="own" data-testid="own-tracks">
			{#if own === undefined}
				{#if ownError}
					<p class="cap muted">Couldn't load {artist.name}'s tracks on this release. <button class="link" onclick={() => onvisible?.(release.id)}>Retry</button></p>
				{:else}
					<div class="skrow" aria-busy="true" aria-label="Loading {artist.name}'s tracks"><div class="skel" style="height:14px;width:55%"></div><div class="skel" style="height:12px;width:30%"></div></div>
				{/if}
			{:else if own.length}
				<CatalogTrackRows tracks={own} albumId={release.id} albumName={release.name} showArtists hideArtistId={artist.id} testid="own-rows" />
			{:else}
				<p class="cap muted">No track on this release credits {artist.name} by id.</p>
			{/if}
			<button class="btn ghost sm full" aria-expanded={open} onclick={toggle} data-testid="show-full">{open ? 'Hide full album' : 'Show full album'}</button>
		</div>
	{/if}

	{#if open}
		<div class="tracks" data-testid="full-tracks">
			{#if loading}
				<div class="skrow" aria-busy="true" aria-label="Loading tracklist"><div class="skel" style="height:14px;width:60%"></div><div class="skel" style="height:14px;width:45%"></div></div>
			{:else if full}
				<CatalogTrackRows tracks={full.tracks} albumId={release.id} albumName={release.name} showArtists hideArtistId={appears ? null : artist.id} testid="full-rows" />
			{/if}
		</div>
	{/if}
	{#if error}<p class="cap" style="color:var(--danger)">{error}</p>{/if}
</article>

<style>
	.rel {
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
		content-visibility: auto;
		contain-intrinsic-size: auto 96px;
	}
	.head {
		display: flex;
		gap: 12px;
		align-items: center;
	}
	.cover {
		flex: none;
		display: block;
	}
	.meta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.name {
		color: var(--text-1);
		font-weight: 700;
		font-size: 15px;
	}
	.sub {
		font-size: 13px;
		color: var(--text-2);
	}
	.state {
		font-size: 12px;
		font-weight: 700;
	}
	.state.liked {
		color: var(--accent);
	}
	.state.played {
		color: var(--success);
	}
	.state.not_heard {
		color: var(--text-3);
	}
	.btn.sm {
		flex: none;
		height: 32px;
		padding: 0 12px;
		font-size: 13px;
	}
	.own {
		margin: 8px 0 0 76px;
	}
	.full {
		margin-top: 8px;
	}
	.tracks {
		margin: 8px 0 0 76px;
	}
	.skrow {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 0;
	}
	.link {
		color: var(--accent);
		text-decoration: underline;
	}
	@media (max-width: 520px) {
		.own,
		.tracks {
			margin-left: 0;
		}
	}
</style>
