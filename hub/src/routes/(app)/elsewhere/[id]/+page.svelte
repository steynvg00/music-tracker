<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { apiPost, describeFailure } from '$lib/player/api-client';
	import { createSoundCloudWidget, isPreview, widgetSrc, type ScController } from '$lib/players/soundcloud';
	import { YT_NOT_EMBEDDABLE, YT_STATE, YT_UNPLAYABLE, createYouTubePlayer, type YtController } from '$lib/players/youtube';
	import { media } from '$lib/stores/media.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { SOURCE_LABEL, playable, step, type CollectionDetail } from '$lib/shared/elsewhere';
	import { fmtDate, fmtTime } from '$lib/shared/format';

	/**
	 * One Elsewhere collection with its own, visible player (R4). Laptop: YouTube/SoundCloud player
	 * in the right column (≥ 480×270). Mobile: a full-screen sheet. Closing the sheet or leaving the
	 * page stops playback: there is never a hidden or background player. Next/Previous stay within
	 * this collection; items that can't play here are skipped with a notice.
	 */
	let { data } = $props();
	const c = $derived(data.r.data as CollectionDetail | null);
	let items = $state<CollectionDetail['items']>([]);
	$effect.pre(() => {
		items = c?.items.map((i) => ({ ...i })) ?? [];
	});

	let index = $state<number | null>(null);
	let status = $state<'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'blocked'>('idle');
	let sheetOpen = $state(false);
	let ytEl: HTMLDivElement | undefined = $state();
	let scEl: HTMLIFrameElement | undefined = $state();
	let yt: YtController | null = null;
	let sc: ScController | null = null;
	let ready: Promise<void> | null = null;
	let deleting = $state(false);

	const current = $derived(index !== null ? items[index] : null);
	const stageVisible = $derived(media.laptop || sheetOpen);
	const spotifyPlaying = $derived(player.view.isPlaying);

	async function flag(i: number, f: 'not_embeddable' | 'preview_only' | 'unavailable') {
		const it = items[i];
		if (!it || !c) return;
		if (f === 'not_embeddable') it.embeddable = false;
		if (f === 'preview_only') it.previewOnly = true;
		if (f === 'unavailable') it.unavailable = true;
		await apiPost(`/api/collections/${c.id}/flags`, { mediaItemId: it.id, flag: f }).catch(() => undefined);
	}

	function ensurePlayer(): Promise<void> {
		if (ready) return ready;
		if (!c) return Promise.resolve();
		ready = (async () => {
			if (c.source === 'youtube' && ytEl) {
				yt = await createYouTubePlayer(ytEl, {
					ready: () => undefined,
					state: (s) => {
						if (s === YT_STATE.PLAYING) status = 'playing';
						else if (s === YT_STATE.PAUSED) status = 'paused';
						else if (s === YT_STATE.ENDED) void advance(1, true);
					},
					error: (code) => {
						if (index === null || !YT_UNPLAYABLE.has(code)) return;
						const t = items[index]?.title ?? 'this video';
						const embed = YT_NOT_EMBEDDABLE.has(code);
						toasts.show(embed ? `Skipped “${t}” — the uploader doesn’t allow embedding` : `Skipped “${t}” — it’s no longer available`);
						void flag(index, embed ? 'not_embeddable' : 'unavailable').then(() => advance(1, true));
					},
					autoplayBlocked: () => (status = 'blocked')
				});
			} else if (c.source === 'soundcloud' && scEl) {
				sc = await createSoundCloudWidget(scEl, {
					ready: () => undefined,
					play: async () => {
						status = 'playing';
						const s = await sc?.current();
						if (isPreview(s)) {
							toasts.show(`Skipped “${s?.title ?? 'a track'}” — Go+ tracks only play a 30-second preview here`);
							if (c.kind === 'manual' && index !== null) void flag(index, 'preview_only');
							sc?.next();
						}
					},
					pause: () => (status = 'paused'),
					finish: () => {
						if (c.kind === 'manual') status = 'ended';
					},
					error: () => toasts.error('SoundCloud couldn’t play this')
				});
			}
		})();
		return ready;
	}

	async function start(i: number) {
		if (!c || !items[i] || !playable(items[i]!)) return;
		if (!media.laptop) sheetOpen = true;
		index = i;
		status = 'loading';
		await Promise.resolve(); // let the stage render visible first
		await ensurePlayer();
		if (c.source === 'youtube') yt?.load(items[i]!.sourceId, true);
		else sc?.play();
	}

	async function advance(dir: 1 | -1, auto = false) {
		if (!c) return;
		if (c.source === 'soundcloud') {
			if (dir === 1) sc?.next();
			else sc?.prev();
			return;
		}
		const next = step(items, index ?? -1, dir);
		if (next === null) {
			if (auto) status = 'ended';
			return;
		}
		index = next;
		yt?.load(items[next]!.sourceId, true);
	}

	function stop() {
		yt?.pause();
		sc?.pause();
		status = status === 'idle' ? 'idle' : 'paused';
	}
	function closeSheet() {
		stop();
		sheetOpen = false;
	}
	function firstPlayable(): number | null {
		return step(items, -1, 1);
	}

	async function remove() {
		if (!c || deleting) return;
		deleting = true;
		try {
			const res = await fetch(`/api/collections/${c.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			toasts.show(`Removed ${c.title} from Rotor`);
			await goto(`/library?source=${c.source}`);
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			deleting = false;
		}
	}

	onDestroy(() => {
		try {
			yt?.destroy();
		} catch {
			/* already gone */
		}
	});
</script>

<svelte:head><title>Rotor · {c?.title ?? 'Elsewhere'}</title></svelte:head>

<div class="view">
	<Header title="Elsewhere" />
	{#if !c}
		<StatsError r={data.r} />
	{:else}
		<div class="layout" class:laptop={media.laptop}>
			<div class="main">
				<header class="hd">
					{#if c.artworkUrl}<img class="art" src={c.artworkUrl} alt="" width="120" height="120" referrerpolicy="no-referrer" />{/if}
					<div>
						<span class="src {c.source}">{SOURCE_LABEL[c.source]}</span>
						<h1 class="ttl">{c.title}</h1>
						<p class="cap muted">{c.owner ?? ''}{c.owner ? ' · ' : ''}{c.itemCount} item{c.itemCount === 1 ? '' : 's'} · last checked {fmtDate(c.lastSyncedAt)}{c.lastImportUnits !== null ? ` · ${c.lastImportUnits} quota units` : ''}</p>
						<div class="acts">
							<button class="btn pri" onclick={() => (index === null ? firstPlayable() !== null && start(firstPlayable()!) : status === 'playing' ? stop() : start(index))} disabled={firstPlayable() === null}>
								<Icon name={status === 'playing' ? 'pause' : 'play'} size={18} />
								{status === 'playing' ? 'Pause' : 'Play'}
							</button>
							<a class="btn sec" href={c.url} target="_blank" rel="noopener">Open on {SOURCE_LABEL[c.source]}</a>
							<button class="btn ghost" onclick={remove} disabled={deleting}>Remove from Rotor</button>
						</div>
					</div>
				</header>
				{#if spotifyPlaying && status !== 'idle'}
					<p class="notice">Spotify is still playing{player.view.device ? ` on ${player.view.device.name}` : ''}. <button class="link" onclick={() => player.pause()}>Pause Spotify</button></p>
				{/if}

				{#if c.source === 'youtube'}
					<ol class="items" aria-label="Videos">
						{#each items as it, i (it.id)}
							<li class:cur={i === index} class:off={!playable(it)}>
								<button onclick={() => start(i)} disabled={!playable(it)} aria-label="Play {it.title}">
									<span class="n tab-num">{i + 1}</span>
									{#if it.artworkUrl}<img src={it.artworkUrl} alt="" width="64" height="36" loading="lazy" referrerpolicy="no-referrer" />{:else}<span class="thumb" aria-hidden="true"></span>{/if}
									<span class="t"><span class="ell">{it.title}</span><span class="cap muted ell">{it.artist ?? ''}</span></span>
									<span class="cap">{it.unavailable ? 'Unavailable' : it.embeddable === false ? 'Can’t play here' : it.durationMs ? fmtTime(it.durationMs) : ''}</span>
								</button>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="cap muted">The SoundCloud widget plays the whole {c.kind === 'set' ? 'set' : 'track'}; Previous / Next move within it.</p>
				{/if}
				<p class="cap muted foot">Played in {SOURCE_LABEL[c.source]}’s own player while this page is open (it stops when the phone locks). Titles as {SOURCE_LABEL[c.source]} returns them. Never mixed with Spotify.</p>
			</div>

			<aside class="stage" class:open={stageVisible} class:sheet={!media.laptop} aria-label="{SOURCE_LABEL[c.source]} player" aria-hidden={!stageVisible} inert={!stageVisible}>
				{#if !media.laptop}
					<div class="sheet-h"><button class="ibtn" aria-label="Close player" onclick={closeSheet}><Icon name="close" size={20} /></button><span class="ell">{current?.title ?? c.title}</span></div>
				{/if}
				<div class="frame" data-testid="elsewhere-player">
					{#if c.source === 'youtube'}
						<div bind:this={ytEl}></div>
					{:else}
						<iframe bind:this={scEl} title="SoundCloud player" src={widgetSrc(c.url)} allow="autoplay; encrypted-media"></iframe>
					{/if}
				</div>
				{#if status === 'blocked'}<p class="notice">Tap the play button in the player to start (your browser blocked autoplay).</p>{/if}
				<div class="ctl">
					<button class="btn sec" onclick={() => advance(-1)} disabled={c.source === 'youtube' && step(items, index ?? -1, -1) === null}><Icon name="prev" size={16} /> Previous</button>
					<span class="cap muted ell" aria-live="polite">{status === 'ended' ? 'End of collection' : current ? current.title : ''}</span>
					<button class="btn sec" onclick={() => advance(1)} disabled={c.source === 'youtube' && step(items, index ?? -1, 1) === null}>Next <Icon name="next" size={16} /></button>
				</div>
			</aside>
		</div>
	{/if}
</div>

<style>
	/* Side by side only when the content area is wide enough (sidebar + now-playing panel eat the
	   rest); otherwise the visible player sits above the list. */
	.layout {
		container-type: inline-size;
	}
	@container (min-width: 1000px) {
		.layout.laptop > .main,
		.layout.laptop > .stage {
			min-width: 0;
		}
	}
	.layout.laptop {
		display: flex;
		flex-direction: column-reverse;
		gap: 16px;
	}
	@container (min-width: 1000px) {
		.layout.laptop {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(480px, 40%);
			gap: 24px;
			align-items: start;
		}
	}
	.hd {
		display: flex;
		gap: 16px;
		align-items: flex-start;
		margin: 4px 0 14px;
	}
	.art {
		border-radius: var(--r-art-l);
		object-fit: cover;
		flex: none;
	}
	.ttl {
		font-size: 24px;
		font-weight: 800;
		margin: 6px 0 4px;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.src {
		font-size: 11px;
		font-weight: 700;
		padding: 3px 8px;
		border-radius: var(--r-pill);
		border: 1px solid currentColor;
	}
	.src.youtube {
		color: var(--src-youtube);
	}
	.src.soundcloud {
		color: var(--src-soundcloud);
	}
	.items {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.items button {
		display: grid;
		grid-template-columns: 28px 64px 1fr auto;
		gap: 10px;
		align-items: center;
		width: 100%;
		text-align: left;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		min-height: 52px;
	}
	.items img,
	.items .thumb {
		width: 64px;
		height: 36px;
		border-radius: 4px;
		object-fit: cover;
		background: var(--surface-3);
		display: block;
	}
	.items .t {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.items li.cur .t > span:first-child {
		color: var(--accent);
		font-weight: 700;
	}
	.items li.off {
		opacity: 0.45;
	}
	.n {
		color: var(--text-3);
		text-align: right;
	}
	.stage {
		position: relative;
	}
	@container (min-width: 1000px) {
		.stage {
			position: sticky;
			top: 16px;
		}
	}
	.stage.sheet {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: var(--bg);
		padding: calc(var(--safe-top) + 8px) var(--gutter) calc(var(--safe-bottom) + 16px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		transform: translateY(100%);
		transition: transform var(--t-sheet) var(--ease-emph);
	}
	.stage.sheet.open {
		transform: none;
	}
	.sheet-h {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 700;
	}
	/* Visible and intact: 16:9, never smaller than 480×270 on the laptop or 200 px high on mobile. */
	.frame {
		width: 100%;
		aspect-ratio: 16 / 9;
		min-height: 200px;
		background: #000;
		border-radius: var(--r-art-l);
		overflow: hidden;
	}
	.layout.laptop .frame {
		min-width: 480px;
		min-height: 270px;
	}
	.frame > div,
	.frame :global(iframe),
	.frame iframe {
		width: 100%;
		height: 100%;
		border: 0;
		display: block;
	}
	.ctl {
		display: flex;
		gap: 10px;
		align-items: center;
		justify-content: space-between;
		margin-top: 10px;
	}
	.foot {
		margin-top: 18px;
	}
	.link {
		color: var(--accent);
		text-decoration: underline;
	}
</style>
