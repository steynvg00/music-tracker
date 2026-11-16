<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import EmbedPlayer from '$lib/components/own/EmbedPlayer.svelte';
	import { apiDelete, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { ownPlayer, setItem } from '$lib/stores/own-player.svelte';
	import { artistLine, fmtClock } from '$lib/shared/own';
	import { SET_SOURCE_LABEL, entryIndexAt, type TracklistEntry } from '$lib/shared/sets';
	import { fmtDate } from '$lib/shared/format';
	import { trackHref } from '$lib/shared/stats';

	/**
	 * One set (v0.94). YouTube / SoundCloud play in their official, visible players; uploads in Rotor's
	 * own player. Tapping a tracklist entry seeks there (official seek API / audio currentTime).
	 */
	let { data } = $props();
	const s = $derived(data.r.data);
	let embed = $state<{ seek: (ms: number) => Promise<void> } | null>(null);
	let embedPos = $state(0);
	let confirmDelete = $state(false);
	let busy = $state(false);

	const mine = $derived(!!s && ownPlayer.current?.kind === 'set' && ownPlayer.current.id === s.id);
	const pos = $derived(s?.source === 'upload' ? (mine ? ownPlayer.positionMs : -1) : embedPos);
	const playingIndex = $derived(s && pos >= 0 ? entryIndexAt(s.tracklist, pos) : -1);

	async function seekTo(e: TracklistEntry) {
		if (!s || e.startMs === null) return;
		if (s.source === 'upload') {
			const it = setItem(s);
			if (!it) return;
			if (mine) ownPlayer.seek(e.startMs);
			else await ownPlayer.play([it], 0, e.startMs);
		} else await embed?.seek(e.startMs);
	}
	function playUpload() {
		const it = s ? setItem(s) : null;
		if (it) void ownPlayer.play([it]);
	}
	async function remove() {
		if (!s) return;
		busy = true;
		try {
			if (mine) await ownPlayer.stop();
			const r = await apiDelete<{ files: number }>(`/api/sets/${s.id}`);
			toasts.show(`Deleted “${s.title}”${r.files ? ' and its uploaded file(s)' : ''}`);
			await goto('/sets');
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			busy = false;
			confirmDelete = false;
		}
	}
	const href = (e: TracklistEntry) => (e.kind === 'catalog' && e.trackUri ? trackHref(e.trackUri) : e.kind === 'own' && e.ownTrackId ? `/own/${e.ownTrackId}` : null);
</script>

<svelte:head><title>Rotor · {s?.title ?? 'Set'}</title></svelte:head>

<div class="view">
	<Header title="Set" />
	{#if !s}
		<StatsError r={data.r} />
	{:else}
		<div class="grid">
			<div class="stagecol">
				<header class="hd" data-testid="set-detail">
					<span class="badge">{SET_SOURCE_LABEL[s.source]}</span>
					<h1 class="ttl">{s.title}</h1>
					<p class="by">
						{#each s.artists as a, i (a.kind + a.id)}{i ? ', ' : ''}{#if a.kind === 'spotify'}<a href="/artist/{a.id}">{a.name}</a>{:else}<span>{a.name}</span>{/if}{/each}
					</p>
					<p class="cap muted">{s.event ?? ''}{s.event && s.date ? ' · ' : ''}{s.date ? fmtDate(s.date) : ''} · {fmtClock(s.durationMs)}</p>
					<div class="acts">
						{#if s.source === 'upload'}<button class="btn pri" onclick={playUpload} data-testid="set-play"><Icon name="play" size={16} /> Play</button>{/if}
						<a class="btn sec" href="/sets/{s.id}/edit">Edit</a>
						<button class="btn danger" onclick={() => (confirmDelete = true)}>Delete</button>
					</div>
				</header>
				{#if s.source !== 'upload'}
					<EmbedPlayer bind:this={embed} youtubeId={s.youtubeId} soundcloudUrl={s.soundcloudUrl} title={s.title} onposition={(ms) => (embedPos = ms)} />
				{:else if s.cover}
					<img class="cover" src={s.cover} alt="" referrerpolicy="no-referrer" />
				{/if}
			</div>
			<section class="tlcol" aria-label="Tracklist">
				<div class="sec-h"><h2>Tracklist</h2></div>
				{#if !s.tracklist.length}
					<p class="muted">No tracklist. <a href="/sets/{s.id}/edit">Paste one</a>.</p>
				{:else}
					<ol class="tl" data-testid="tracklist">
						{#each s.tracklist as e, i (i)}
							<li class:now={i === playingIndex} data-kind={e.kind}>
								<button class="seek" disabled={e.startMs === null} onclick={() => seekTo(e)} aria-label={e.startMs === null ? `${e.title} (no time)` : `Play from ${fmtClock(e.startMs)}: ${e.artist ?? ''} ${e.title}`} data-testid="tl-seek">
									<span class="tab-num ts">{e.startMs === null ? '—' : fmtClock(e.startMs)}</span>
									<span class="t ell">{e.artist ? `${e.artist} – ` : ''}{e.title}</span>
								</button>
								{#if e.kind === 'id'}<span class="badge id">ID</span>{:else if href(e)}<a class="badge" href={href(e)}>{e.kind === 'own' ? 'Own' : 'Track'}</a>{/if}
							</li>
						{/each}
					</ol>
				{/if}
				<p class="cap muted">{s.source === 'upload' ? 'Plays in Rotor’s player (lock-screen controls).' : `Plays in ${SET_SOURCE_LABEL[s.source]}’s own player while this page is open.`} {artistLine(s.artists)}</p>
			</section>
		</div>
	{/if}
</div>

<Sheet open={confirmDelete} onclose={() => (confirmDelete = false)} label="Delete set">
	<div class="sheet">
		<h2>Delete “{s?.title}”?</h2>
		<p class="cap">Removes the set and its tracklist{s?.audio || s?.coverObjectId ? ', and its uploaded file(s) from storage' : ''}. Own tracks you heard in it keep a note. This can’t be undone.</p>
		<div class="acts">
			<button class="btn danger" disabled={busy} onclick={remove}>{busy ? 'Deleting…' : 'Delete'}</button>
			<button class="btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
		</div>
	</div>
</Sheet>

<style>
	.grid {
		display: grid;
		gap: 16px;
	}
	@media (min-width: 1024px) {
		.grid {
			grid-template-columns: minmax(480px, 1.2fr) minmax(0, 1fr);
			align-items: start;
		}
	}
	.ttl {
		font-size: 26px;
		font-weight: 800;
		margin: 6px 0 2px;
	}
	.by {
		margin: 0 0 4px;
	}
	.acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 10px 0;
	}
	.cover {
		width: 100%;
		max-width: 360px;
		border-radius: 8px;
	}
	.tl {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.tl li {
		display: flex;
		align-items: center;
		gap: 8px;
		border-bottom: 1px solid var(--border);
	}
	.tl li.now {
		background: var(--surface-2);
	}
	.tl li.now .t {
		color: var(--accent);
		font-weight: 700;
	}
	.seek {
		flex: 1;
		min-width: 0;
		display: flex;
		gap: 12px;
		align-items: center;
		background: none;
		border: 0;
		color: var(--text-1);
		font: inherit;
		text-align: left;
		padding: 10px 4px;
		min-height: 44px;
		cursor: pointer;
	}
	.seek[disabled] {
		cursor: default;
		color: var(--text-2);
	}
	.ts {
		color: var(--text-3);
		width: 64px;
		flex: none;
	}
	.badge.id {
		opacity: 0.7;
	}
	.sheet {
		padding: 8px 4px;
	}
</style>
