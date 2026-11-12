<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { apiGet, describeFailure } from '$lib/player/api-client';
	import { createSoundCloudWidget, isPreview, widgetSrc, type ScController } from '$lib/players/soundcloud';
	import { YT_NOT_EMBEDDABLE, YT_STATE, YT_UNPLAYABLE, createYouTubePlayer, type YtController } from '$lib/players/youtube';
	import { media } from '$lib/stores/media.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { Conductor, fmtGap } from '$lib/conductor/conductor.svelte';
	import type { MixItem } from '$lib/conductor/machine';
	import { mixesEnabled } from '$lib/conductor/opt-in';
	import type { Mix, SessionSummary } from '$lib/server/mixes';
	import { SOURCE_LABEL, type Collection, type CollectionDetail } from '$lib/shared/elsewhere';
	import { fmtTime } from '$lib/shared/format';

	/**
	 * A mix (R5, experimental, opt-in per device). Spotify items are text + a "Spotify" badge only;
	 * YouTube/SoundCloud play in their own visible players; only one source sounds at a time.
	 */
	let { data } = $props();
	const mix = $derived(data.r.data as Mix | null);
	let enabled = $state(false);
	let items = $state<MixItem[]>([]);
	let dirty = $state(false);
	const c = new Conductor();
	let summary = $state<SessionSummary | null>(null);
	let showCheck = $state(false);

	$effect.pre(() => {
		items = mix?.items.map((i) => ({ ...i })) ?? [];
	});

	// ── in-app stage ──
	let ytEl: HTMLDivElement | undefined = $state();
	let scEl: HTMLIFrameElement | undefined = $state();
	let yt: YtController | null = null;
	let sc: ScController | null = null;
	let ytReady: Promise<void> | null = null;
	let scReady: Promise<void> | null = null;
	let stageSource = $state<'youtube' | 'soundcloud' | null>(null);
	const firstSc = $derived(items.find((i) => i.source === 'soundcloud')?.sourceId ?? null);
	const stageVisible = $derived(media.laptop || ['handoff', 'inapp', 'blocked'].includes(c.phase));

	function ensureYt(): Promise<void> {
		ytReady ??= (async () => {
			if (!ytEl) return;
			yt = await createYouTubePlayer(ytEl, {
				ready: () => undefined,
				state: (s) => {
					if (s === YT_STATE.PLAYING) c.onInAppPlaying();
					else if (s === YT_STATE.ENDED) c.onInAppEnded();
				},
				error: (code) => {
					if (YT_UNPLAYABLE.has(code)) c.onInAppUnplayable(YT_NOT_EMBEDDABLE.has(code) ? 'not_embeddable' : 'not_embeddable');
				},
				autoplayBlocked: () => c.onInAppBlocked()
			});
		})();
		return ytReady;
	}
	function ensureSc(): Promise<void> {
		scReady ??= (async () => {
			if (!scEl) return;
			sc = await createSoundCloudWidget(scEl, {
				ready: () => undefined,
				play: async () => {
					const s = await sc?.current();
					if (isPreview(s)) c.onInAppUnplayable('preview_skipped');
					else c.onInAppPlaying();
				},
				pause: () => undefined,
				finish: () => c.onInAppEnded(),
				error: () => c.onInAppUnplayable('not_embeddable')
			});
		})();
		return scReady;
	}
	c.inApp = {
		cue: (it) => {
			if (it.source === 'youtube') void ensureYt().then(() => yt?.load(it.sourceId!, false));
			else if (it.source === 'soundcloud') void ensureSc().then(() => sc?.load(it.sourceId!, false));
		},
		play: (it) => {
			stageSource = it.source === 'spotify' ? null : it.source;
			if (it.source === 'youtube') void ensureYt().then(() => yt?.load(it.sourceId!, true));
			else if (it.source === 'soundcloud') void ensureSc().then(() => sc?.load(it.sourceId!, true));
		},
		pause: () => {
			yt?.pause();
			sc?.pause();
		}
	};

	onMount(() => {
		enabled = mixesEnabled();
		if (!mix) return;
		c.load(mix.id, mix.items, media.laptop ? 'laptop' : 'relay');
		const sid = page.url.searchParams.get('session');
		const at = Number(page.url.searchParams.get('at'));
		if (sid && /^[0-9a-f-]{36}$/.test(sid) && Number.isInteger(at)) c.attach(sid, at);
	});
	onDestroy(() => c.destroy());
	$effect(() => {
		void player.view;
		c.tick();
	});

	// ── session controls ──
	async function startSession() {
		summary = null;
		if (dirty) await save();
		c.load(mix!.id, items, media.laptop ? 'laptop' : 'relay');
		const chk = c.precheck();
		if (!chk.ok) {
			showCheck = true;
			return;
		}
		await go();
	}
	async function go() {
		showCheck = false;
		try {
			await c.start();
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	async function moveHere() {
		if (c.mode === 'laptop') await player.pickThisLaptop();
		else {
			await player.refreshDevices();
			const phone = player.devices.find((d) => d.type.toLowerCase() === 'smartphone' && d.id);
			if (phone?.id) await player.pickDevice(phone.id, phone.name);
			else return void toasts.error('Open Spotify on this phone first');
		}
		// The transfer lands a moment later: wait until Spotify really plays here, then check again.
		for (let i = 0; i < 25 && !c.precheck().ok; i++) await new Promise((r) => setTimeout(r, 200));
		if (c.precheck().ok) await go();
		else toasts.error('Spotify didn’t move here yet. Try again in a moment.');
	}
	async function skipInApp() {
		c.spotifyOnly();
		await go();
	}
	async function endSession() {
		await c.end();
		if (c.sessionId) summary = await apiGet<SessionSummary>(`/api/mix-sessions/${c.sessionId}`).catch(() => null);
	}
	$effect(() => {
		if (c.phase === 'ended' && c.sessionId && !summary) void apiGet<SessionSummary>(`/api/mix-sessions/${c.sessionId}`).then((s) => (summary = s)).catch(() => undefined);
	});

	// ── editor ──
	let q = $state('');
	let found = $state<{ uri: string; name: string; artist: string; plays: number }[]>([]);
	let collections = $state<Collection[]>([]);
	let picked = $state<CollectionDetail | null>(null);
	async function searchSpotify(e: SubmitEvent) {
		e.preventDefault();
		if (q.trim().length < 2) return;
		const r = await apiGet<{ tracks: typeof found }>(`/api/search?q=${encodeURIComponent(q.trim())}`).catch(() => ({ tracks: [] }));
		found = r.tracks ?? [];
	}
	async function loadCollections() {
		collections = (await apiGet<{ collections: Collection[] }>('/api/collections').catch(() => ({ collections: [] }))).collections ?? [];
	}
	async function pick(id: string) {
		picked = await apiGet<CollectionDetail>(`/api/collections/${id}`).catch(() => null);
	}
	function add(it: MixItem) {
		items = [...items, { ...it, position: items.length }];
		dirty = true;
	}
	function move(i: number, d: -1 | 1) {
		const j = i + d;
		if (j < 0 || j >= items.length) return;
		const next = [...items];
		[next[i], next[j]] = [next[j]!, next[i]!];
		items = next.map((x, k) => ({ ...x, position: k }));
		dirty = true;
	}
	function remove(i: number) {
		items = items.filter((_, k) => k !== i).map((x, k) => ({ ...x, position: k }));
		dirty = true;
	}
	async function save() {
		const res = await fetch(`/api/mixes/${mix!.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ items: items.map((i) => (i.source === 'spotify' ? { source: 'spotify', spotifyUri: i.spotifyUri } : { source: i.source, mediaItemId: i.mediaItemId })) })
		});
		if (!res.ok) return void toasts.error('Could not save the mix');
		const m = (await res.json()) as Mix;
		items = m.items.map((x) => ({ ...x }));
		dirty = false;
		toasts.show('Mix saved');
	}
	const SRC_LABEL = (s: MixItem['source']) => (s === 'spotify' ? 'Spotify' : SOURCE_LABEL[s]);
	const running = $derived(!['idle', 'ended'].includes(c.phase));
</script>

<svelte:head><title>Rotor · {mix?.name ?? 'Mix'}</title></svelte:head>

<div class="view">
	<Header title="Mix" />
	{#if !mix}
		<StatsError r={data.r} />
	{:else if !enabled}
		<p class="notice">Mixed sessions are off on this device. Turn them on in <a href="/settings#experimental">Settings › Experimental</a>.</p>
	{:else}
		<div class="layout" class:laptop={media.laptop} data-phase={c.phase}>
			<div class="main">
				<h1 class="ttl">{mix.name}</h1>
				<p class="cap muted">Experimental · conflicts with Spotify’s developer policy · {c.mode === 'laptop' ? 'Spotify must play on “This laptop”' : 'iPhone: Spotify plays on this phone, you get a notification when it’s YouTube’s turn'}</p>

				<!-- Source strip: one segment per run, the current one marked. -->
				<ol class="strip" aria-label="Sources in this mix">
					{#each c.runs.length ? c.runs : [] as r (r.start)}
						<li class="seg {r.source}" class:cur={running && c.index >= r.start && c.index <= r.end}><span>{SRC_LABEL(r.source)}</span></li>
					{/each}
				</ol>

				<div class="acts">
					{#if !running}
						<button class="btn pri" onclick={startSession} disabled={!items.length}><Icon name="play" size={18} /> Start session</button>
					{:else}
						<button class="btn sec" onclick={endSession}>End session</button>
					{/if}
					{#if dirty}<button class="btn sec" onclick={save}>Save mix</button>{/if}
				</div>

				{#if c.switching}<p class="cap" aria-live="polite">{c.switching}</p>{/if}
				{#if running && c.nextLabel}<p class="cap muted">Next: {c.nextLabel}</p>{/if}
				{#if c.phase === 'diverged'}
					<div class="notice" role="alert">
						{c.notice}
						<div class="acts"><button class="btn pri" onclick={() => c.resume()}>Resume mix</button><button class="btn sec" onclick={endSession}>End session</button></div>
					</div>
				{:else if c.notice}
					<p class="notice" role="status">{c.notice}</p>
				{/if}
				{#if c.phase === 'blocked'}
					<div class="tap" role="alert">
						<p><b>Tap to continue on {c.current ? SRC_LABEL(c.current.source) : 'YouTube'}</b></p>
						<p class="cap">{c.current?.title ?? ''}</p>
						<button class="btn pri" onclick={() => c.tapToContinue()}>Continue</button>
					</div>
				{/if}

				{#if showCheck && c.check && !c.check.ok}
					<div class="notice" role="alertdialog" aria-label="Music would jump rooms">
						<p>
							{c.check.reason === 'no_device'
								? 'Nothing is playing in Spotify yet.'
								: `Spotify is playing on ${c.check.deviceName}. YouTube would play here, so the music would jump rooms.`}
						</p>
						<div class="acts">
							<button class="btn pri" onclick={moveHere}>Move Spotify here</button>
							<button class="btn sec" onclick={skipInApp}>Skip YouTube items</button>
							<button class="btn ghost" onclick={() => (showCheck = false)}>Cancel</button>
						</div>
					</div>
				{/if}

				{#if summary}
					<section class="section" aria-label="Session summary">
						<div class="sec-h"><h2>Session summary</h2><span class="cap muted">{summary.okHandoffs} of {summary.handoffs} handoffs ok · median gap {fmtGap(summary.medianGapMs)}</span></div>
						<table class="sum">
							<thead><tr><th scope="col">#</th><th scope="col">From → to</th><th scope="col">Outcome</th><th scope="col">Gap</th></tr></thead>
							<tbody>{#each summary.events as e, i (i)}<tr><td>{(e.position ?? 0) + 1}</td><td>{e.from ?? '—'} → {e.to ?? '—'}</td><td>{e.outcome}</td><td class="tab-num">{fmtGap(e.gapMs)}</td></tr>{/each}</tbody>
						</table>
					</section>
				{/if}

				<ol class="items" aria-label="Mix items">
					{#each items as it, i (i + it.title)}
						<li class:cur={running && i === c.index} class:off={it.skip}>
							<span class="n tab-num">{i + 1}</span>
							<span class="src {it.source}">{SRC_LABEL(it.source)}</span>
							<span class="t"><span class="ell">{it.title}</span><span class="cap muted ell">{it.artist ?? ''}{it.skip ? ' · can’t play here' : ''}</span></span>
							<span class="cap">{it.durationMs ? fmtTime(it.durationMs) : ''}</span>
							{#if !running}
								<span class="ed">
									<button class="ibtn" aria-label="Move {it.title} up" onclick={() => move(i, -1)}>↑</button>
									<button class="ibtn" aria-label="Move {it.title} down" onclick={() => move(i, 1)}>↓</button>
									<button class="ibtn" aria-label="Remove {it.title}" onclick={() => remove(i)}><Icon name="close" size={14} /></button>
								</span>
							{/if}
						</li>
					{:else}
						<li class="muted">Empty. Add Spotify tracks and YouTube/SoundCloud items below.</li>
					{/each}
				</ol>

				{#if !running}
					<details class="add">
						<summary>Add a Spotify track (from your history)</summary>
						<form onsubmit={searchSpotify}><input aria-label="Search your tracks" bind:value={q} placeholder="Track or artist" /><button class="btn sec" type="submit">Search</button></form>
						<ul>{#each found as t (t.uri)}<li><span class="ell">{t.name} — {t.artist}</span><button class="btn ghost" onclick={() => add({ position: 0, source: 'spotify', spotifyUri: t.uri, mediaItemId: null, sourceId: null, title: t.name, artist: t.artist, durationMs: null })}>Add</button></li>{/each}</ul>
					</details>
					<details class="add" ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadCollections()}>
						<summary>Add from YouTube / SoundCloud</summary>
						<ul>{#each collections as col (col.id)}<li><span class="ell">{SOURCE_LABEL[col.source]} · {col.title}</span><button class="btn ghost" onclick={() => pick(col.id)}>Open</button></li>{/each}</ul>
						{#if picked}
							<ul>
								{#each picked.items as m (m.id)}
									<li>
										<span class="ell">{m.title}</span>
										{#if picked.source === 'soundcloud' && picked.kind === 'set'}
											<span class="cap muted">sets can’t be mixed (add single tracks)</span>
										{:else}
											<button class="btn ghost" onclick={() => add({ position: 0, source: m.source, spotifyUri: null, mediaItemId: m.id, sourceId: m.sourceId, title: m.title, artist: m.artist, durationMs: m.durationMs, skip: m.embeddable === false || m.previewOnly || m.unavailable })}>Add</button>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</details>
				{/if}
			</div>

			<aside class="stage" class:sheet={!media.laptop} class:open={stageVisible} aria-label="Mix player" aria-hidden={!stageVisible} inert={!stageVisible}>
				<div class="frame" class:hide={stageSource === 'soundcloud'} data-testid="mix-yt"><div bind:this={ytEl}></div></div>
				{#if firstSc}
					<div class="frame" class:hide={stageSource !== 'soundcloud'} data-testid="mix-sc"><iframe bind:this={scEl} title="SoundCloud player" src={widgetSrc(firstSc)} allow="autoplay; encrypted-media"></iframe></div>
				{/if}
				<p class="cap muted">{c.current && c.current.source !== 'spotify' ? c.current.title : 'YouTube and SoundCloud play here, in their own players.'}</p>
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
	.ttl {
		font-size: 24px;
		font-weight: 800;
		margin: 4px 0;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 10px 0;
	}
	.strip {
		display: flex;
		gap: 3px;
		list-style: none;
		padding: 0;
		margin: 10px 0;
	}
	.seg {
		flex: 1;
		text-align: center;
		font-size: 11px;
		font-weight: 700;
		padding: 4px 2px;
		border-radius: 4px;
		background: var(--surface-3);
		color: var(--text-2);
	}
	.seg.youtube {
		box-shadow: inset 0 -3px 0 var(--src-youtube);
	}
	.seg.soundcloud {
		box-shadow: inset 0 -3px 0 var(--src-soundcloud);
	}
	.seg.cur {
		background: var(--accent-subtle);
		color: var(--text-1);
		outline: 1px solid var(--accent);
	}
	.tap {
		background: var(--surface-2);
		border: 1px solid var(--accent);
		border-radius: var(--r-card);
		padding: 16px;
		margin: 10px 0;
	}
	.items {
		list-style: none;
		margin: 12px 0;
		padding: 0;
	}
	.items li {
		display: grid;
		grid-template-columns: 26px auto 1fr auto auto;
		gap: 10px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.items li.cur .t > span:first-child {
		color: var(--accent);
		font-weight: 700;
	}
	.items li.off {
		opacity: 0.45;
	}
	.items .t {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.n {
		color: var(--text-3);
		text-align: right;
	}
	.src {
		font-size: 10px;
		font-weight: 700;
		padding: 2px 6px;
		border-radius: var(--r-pill);
		border: 1px solid currentColor;
		color: var(--text-2);
	}
	.src.youtube {
		color: var(--src-youtube);
	}
	.src.soundcloud {
		color: var(--src-soundcloud);
	}
	.ed {
		display: flex;
	}
	.add {
		margin: 10px 0;
		font-size: 14px;
	}
	.add summary {
		cursor: pointer;
		color: var(--text-2);
		min-height: 36px;
	}
	.add form {
		display: flex;
		gap: 8px;
		margin: 8px 0;
	}
	.add input {
		flex: 1;
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		font: inherit;
	}
	.add ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.add li {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: center;
		padding: 4px 0;
	}
	.sum {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.sum th,
	.sum td {
		text-align: left;
		padding: 4px 6px;
		border-bottom: 1px solid var(--border);
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
		inset: auto 0 0 0;
		z-index: 60;
		background: var(--bg);
		padding: 12px var(--gutter) calc(var(--safe-bottom) + 16px);
		transform: translateY(110%);
		transition: transform var(--t-sheet) var(--ease-emph);
	}
	.stage.sheet.open {
		transform: none;
	}
	.frame {
		width: 100%;
		aspect-ratio: 16 / 9;
		min-height: 200px;
		background: #000;
		border-radius: var(--r-art-l);
		overflow: hidden;
	}
	.frame.hide {
		display: none;
	}
	.layout.laptop .frame {
		min-width: 480px;
		min-height: 270px;
	}
	.frame > div,
	.frame iframe {
		width: 100%;
		height: 100%;
		border: 0;
		display: block;
	}
</style>
