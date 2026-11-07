<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Eq from '$lib/components/Eq.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { fmtInt, fmtTime } from '$lib/shared/format';
	import { catalogArtistHref, type CatalogTrack } from '$lib/shared/catalog';

	/**
	 * Track rows for the Artist pages (beta) and the catalog album page. ▶ plays that track on the
	 * active device (Spotify Connect via the existing remote control); "From here" plays the release
	 * (album context) starting at that track. Plays / liked are your own data.
	 */
	let {
		tracks,
		albumId,
		albumName,
		showArtists = false,
		hideArtistId = null,
		testid = 'track-rows'
	}: { tracks: CatalogTrack[]; albumId: string; albumName: string; showArtists?: boolean; hideArtistId?: string | null; testid?: string } = $props();

	const contextUri = $derived(`spotify:album:${albumId}`);
	const playingUri = $derived(player.view.item?.uri ?? null);

	function playOne(t: CatalogTrack) {
		void player.play({ type: 'play', body: { uris: [t.uri] }, label: t.name });
	}
	function fromHere(t: CatalogTrack) {
		void player.playContext(contextUri, albumName, { uri: t.uri });
	}
	const others = (t: CatalogTrack) => t.artists.filter((a) => !hideArtistId || a.id !== hideArtistId);
</script>

<ol class="rows" data-testid={testid}>
	{#each tracks as t, i (t.id + i)}
		<li class="row" class:playing={playingUri === t.uri} data-testid="track-row" data-uri={t.uri} data-plays={t.plays}>
			<span class="idx tab-num">{#if playingUri === t.uri}<Eq paused={!player.view.isPlaying} />{:else}{t.number || i + 1}{/if}</span>
			<span class="grow">
				<span class="rt ell" title={t.name}>{t.name}{#if t.liked}<span class="liked" title="In your liked songs" aria-label="Liked"> ♥</span>{/if}</span>
				{#if showArtists && others(t).length}
					<span class="rm ell">{#each others(t) as a, j (a.name + j)}{j ? ', ' : ''}{#if catalogArtistHref(a.id)}<a href={catalogArtistHref(a.id)}>{a.name}</a>{:else}{a.name}{/if}{/each}</span>
				{/if}
			</span>
			<span class="plays tab-num" class:muted={!t.plays}>{t.plays ? `${fmtInt(t.plays)} plays` : 'not heard'}</span>
			<span class="dur tab-num">{t.durationMs ? fmtTime(t.durationMs) : ''}</span>
			<button class="ibtn sm" aria-label="Play {t.name}" title="Play this track" onclick={() => playOne(t)}><Icon name="play" size={16} /></button>
			<button class="here" aria-label="From here: play {albumName} from {t.name}" title="Play the release from here" onclick={() => fromHere(t)}>From here</button>
		</li>
	{/each}
</ol>

<style>
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 4px 0;
		border-bottom: 1px solid var(--border);
	}
	.row.playing .rt {
		color: var(--accent);
	}
	.idx {
		width: 26px;
		text-align: right;
		color: var(--text-3);
		font-size: 13px;
		flex: none;
	}
	.grow {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.rt {
		font-size: 15px;
		color: var(--text-1);
	}
	.rm {
		font-size: 13px;
		color: var(--text-2);
	}
	.rm a {
		color: inherit;
	}
	.liked {
		color: var(--accent);
	}
	.plays {
		font-size: 12px;
		color: var(--text-2);
		flex: none;
	}
	.dur {
		font-size: 12px;
		color: var(--text-3);
		width: 38px;
		text-align: right;
		flex: none;
	}
	.ibtn.sm {
		width: 36px;
		height: 36px;
		flex: none;
	}
	.here {
		flex: none;
		font-size: 12px;
		font-weight: 700;
		color: var(--text-2);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		padding: 6px 10px;
	}
	.here:hover {
		color: var(--text-1);
	}
	@media (max-width: 520px) {
		.dur {
			display: none;
		}
		.here {
			padding: 6px 8px;
		}
	}
</style>
