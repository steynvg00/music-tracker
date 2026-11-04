<script lang="ts">
	import Art from '$lib/components/Art.svelte';
	import Attribution from '$lib/components/Attribution.svelte';
	import Eq from '$lib/components/Eq.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import KindBadge from '$lib/components/KindBadge.svelte';
	import RotorCover from '$lib/components/RotorCover.svelte';
	import TrackRows from '$lib/components/TrackRows.svelte';
	import { apiGet } from '$lib/player/api-client';
	import { daily } from '$lib/stores/daily.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { fmtDuration } from '$lib/shared/format';
	import { DAILY_PICK_PLAYLIST_NAME } from '$lib/shared/managed';
	import type { TrackRow } from '$lib/shared/daily-types';

	const RECIPES: Record<string, string> = {
		forgotten_gems: 'Forgotten gems',
		evergreen_core: 'Evergreen core',
		fresh_heat: 'Fresh heat',
		artist_deep_dive: 'Artist deep dive',
		discovered_in_year: 'Discovered in a year'
	};

	let { data } = $props();
	$effect.pre(() => daily.set(data.deck));

	const c = $derived(daily.current);
	const deck = $derived(daily.deck);
	const playing = $derived(daily.isCurrentContext && player.view.isPlaying);
	let tracks = $state<{ key: string; readable: boolean; rows: TrackRow[] } | null>(null);

	$effect(() => {
		if (!deck || !c) return;
		const key = `${deck.date}:${c.rank}`;
		if (tracks?.key === key) return;
		tracks = null;
		apiGet<{ readable: boolean; tracks: TrackRow[] }>(`/api/daily/tracks?date=${deck.date}&rank=${c.rank}`)
			.then((r) => (tracks = { key, readable: r.readable, rows: r.tracks }))
			.catch(() => (tracks = { key, readable: false, rows: [] }));
	});

	function playAt(i: number) {
		if (!c || !deck) return;
		if (c.kind === 'generated') void daily.play(i);
		else if (c.playlist) void player.playContext(c.playlist.uri, c.title, { position: i });
	}
</script>

<svelte:head><title>Rotor · Today's pick</title></svelte:head>

<div class="view">
	{#if !deck || !c}
		<div class="dhead">
			<a class="backbtn" href="/home" aria-label="Back"><Icon name="back" size={18} /></a>
			<div class="htext"><div class="over">Today's pick</div><h1>Not mixed yet</h1><p class="cap">The generator runs every morning. Nothing for {data.deck.date} yet.</p></div>
		</div>
	{:else}
		<div class="dhead">
			<a class="backbtn" href="/home" aria-label="Back"><Icon name="back" size={18} /></a>
			{#if daily.rotating || daily.reseeding}
				<div class="skel" style="width:200px;height:200px;border-radius:8px;flex:none"></div>
			{:else if c.kind === 'generated'}
				<RotorCover title={c.title} recipe={c.recipe} size={200} />
			{:else}
				<Art src={c.playlist?.imageUrl} size={200} />
			{/if}
			<div class="htext">
				<div class="over">Today's pick · {daily.index + 1} of {deck.candidates.length}</div>
				<h1 title={c.title}>{daily.rotating ? 'Rotating…' : daily.reseeding ? 'Mixing new picks…' : c.title}</h1>
				<div class="meta">
					{#if c.kind === 'generated'}
						<span class="badge acc">Generated</span><span class="cap">Recipe: {RECIPES[c.recipe ?? ''] ?? c.recipe}</span>
					{:else}
						<span class="badge">From your library</span><KindBadge kind={c.playlist?.kind ?? null} isOwned={!!c.playlist?.isOwned} isCollab={!!c.playlist?.isCollab} />
					{/if}
					{#if c.trackCount}<span class="cap">· {c.trackCount} tracks</span>{/if}
					{#if c.durationMs}<span class="cap">· {fmtDuration(c.durationMs)}</span>{/if}
				</div>
				<p class="cap" style="margin-top:6px">{c.reason}</p>
				<div class="acts">
					<button class="play xl" aria-label={playing ? 'Pause' : 'Play'} onclick={() => daily.play()}>
						{#if playing}<Icon name="pause" />{:else}<Icon name="play" />{/if}
					</button>
					<button class="btn sec" disabled={daily.rotating || daily.reseeding} onclick={() => daily.rotate()}>
						<Icon name="rotate" size={18} />
						{daily.isLast ? 'Shuffle the deck' : 'Rotate'}
					</button>
					<span class="spacer"></span>
					<Attribution uri={c.kind === 'generated' ? deck.dailyPlaylistUri : c.playlist?.uri} />
				</div>
			</div>
		</div>

		{#if c.kind === 'generated'}
			<div class="notice"><Icon name="note" size={18} /><span>Pressing Play writes these tracks into <b>{DAILY_PICK_PLAYLIST_NAME}</b> (managed suffix, so Rotor may edit it) and plays that playlist{player.deviceName ? ` on ${player.deviceName}` : ''}.</span></div>
		{:else if c.playlist && !c.playlist.isOwned && !c.playlist.isCollab}
			<div class="notice"><Icon name="lock" size={18} /><span>You follow this playlist but don't own it. Spotify only returns track lists for playlists you own or collaborate on, so Rotor can <b>play</b> it but not show its tracks.</span></div>
		{:else}
			<div class="notice"><Icon name="lock" size={18} /><span>{c.playlist?.kind ? 'A managed playlist: the crons keep it up to date. Rotor only plays it here.' : 'Your own playlist without a managed suffix: read & play only. Rotor never edits it.'}</span></div>
		{/if}

		{#if !tracks}
			<div class="rows">
				{#each [1, 2, 3, 4, 5] as i (i)}<div class="row"><div class="skel" style="width:22px;height:12px"></div><div class="grow"><div class="skel" style="height:12px;width:60%"></div><div class="skel" style="height:10px;width:35%;margin-top:6px"></div></div></div>{/each}
			</div>
		{:else if tracks.rows.length}
			<TrackRows rows={tracks.rows} contextUri={daily.contextUri} onplayat={playAt} />
		{:else if tracks.readable}
			<p class="cap muted" style="margin-top:14px">No mirrored tracks yet: the nightly mirror fills these in.</p>
		{/if}

		{#if deck.candidates.length > 1}
			<section class="section">
				<div class="sec-h"><h2>Other candidates today</h2></div>
				<div class="rows">
					{#each deck.candidates.filter((x) => x.rank !== c.rank) as x (x.rank)}
						<button class="row" onclick={() => daily.select(x.rank)}>
							{#if x.kind === 'generated'}<RotorCover title={x.title} recipe={x.recipe} size={48} />{:else}<Art src={x.playlist?.imageUrl} size={48} />{/if}
							<span class="grow">
								<span class="rt ell" style="display:block">{x.title}</span>
								<span class="rm ell" style="display:block">{x.kind === 'generated' ? 'Generated' : 'From your library'} · {x.reason}</span>
							</span>
							{#if deck.state?.playedRank === x.rank}<Eq paused />{/if}
						</button>
					{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.dhead {
		position: relative;
		margin: 0 calc(-1 * var(--gutter));
		padding: calc(var(--safe-top) + 56px) var(--gutter) 16px;
		background: linear-gradient(180deg, color-mix(in srgb, #3a2a66 80%, #000) 0%, var(--bg) 100%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}
	.dhead > :global(.art),
	.dhead > .skel {
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
	}
	.htext {
		width: 100%;
	}
	.backbtn {
		position: absolute;
		top: calc(var(--safe-top) + 12px);
		left: 16px;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: rgba(0, 0, 0, 0.35);
	}
	h1 {
		font-size: 28px;
		line-height: 32px;
		font-weight: 800;
		letter-spacing: -0.03em;
		word-break: break-word;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 16px;
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
	}
	.play.xl {
		width: 56px;
		height: 56px;
	}
	@media (min-width: 768px) {
		.dhead {
			flex-direction: row;
			align-items: flex-end;
			gap: 24px;
			padding-top: 64px;
			background: linear-gradient(180deg, color-mix(in srgb, #3a2a66 80%, #000) 0%, var(--surface-1) 100%);
			border-radius: 10px 10px 0 0;
		}
		.htext {
			flex: 1;
			min-width: 0;
		}
		h1 {
			font-size: 48px;
			line-height: 52px;
		}
	}
</style>
