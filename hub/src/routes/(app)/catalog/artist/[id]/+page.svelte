<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import Art from '$lib/components/Art.svelte';
	import Attribution from '$lib/components/Attribution.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import ReleaseCard from '$lib/components/catalog/ReleaseCard.svelte';
	import { ApiFailure, apiGet, apiPost, describeFailure } from '$lib/player/api-client';
	import { flags } from '$lib/stores/flags.svelte';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { byYear, GROUP_LABEL, RELEASE_GROUPS, sortReleases, type ArtistPage, type CatalogTrack, type ReleaseGroup, type ReleaseWithState, type SortOrder, type YearBlock } from '$lib/shared/catalog';

	/**
	 * Artist pages (beta, v0.90). Header: YOUR numbers. Body: the artist's complete discography from
	 * Spotify, all four groups on the page (nothing hidden; the chips only jump), sorted by release
	 * date with year headers. Appears-on releases load this artist's own tracks as they scroll in.
	 */
	let { data } = $props();
	let mounted = $state(false);
	onMount(() => (mounted = true));

	let page = $state<ArtistPage | null>(null);
	let error = $state<string | null>(null);
	let waitS = $state<number | null>(null);
	let order = $state<SortOrder>('newest');

	// Appears-on own tracks, loaded in batches as cards become visible.
	let own = $state<Record<string, CatalogTrack[]>>({});
	let ownErr = $state<Record<string, boolean>>({});
	let queue: string[] = [];
	let queued = new Set<string>();
	let inflight = 0;
	let pumpTimer: ReturnType<typeof setTimeout> | undefined;
	let gen = 0;
	const BATCH = 12;
	const MAX_INFLIGHT = 2;

	async function load(id: string, attempt = 0) {
		const my = ++gen;
		error = null;
		waitS = null;
		try {
			const p = await apiGet<ArtistPage>(`/api/catalog/artist/${id}`);
			if (my !== gen) return;
			page = p;
		} catch (e) {
			if (my !== gen) return;
			if (e instanceof ApiFailure && e.status === 429 && attempt < 5) {
				waitS = e.retryAfterS ?? 5;
				setTimeout(() => my === gen && void load(id, attempt + 1), waitS * 1000);
				return;
			}
			error = e instanceof ApiFailure && e.status === 503 ? (e.body.message ?? 'Artist pages need migration 0031.') : describeFailure(e);
		}
	}

	$effect(() => {
		const id = data.id;
		if (!mounted || !flags.artistPages) return;
		page = null;
		own = {};
		ownErr = {};
		queue = [];
		queued = new Set();
		void load(id);
	});

	function want(albumId: string) {
		if (own[albumId] || queued.has(albumId)) return;
		if (ownErr[albumId]) ownErr = { ...ownErr, [albumId]: false };
		queued.add(albumId);
		queue.push(albumId);
		clearTimeout(pumpTimer);
		pumpTimer = setTimeout(pump, 40);
	}

	function pump() {
		while (inflight < MAX_INFLIGHT && queue.length) {
			const batch = queue.splice(0, BATCH);
			inflight++;
			void send(batch, gen).finally(() => {
				inflight--;
				pump();
			});
		}
	}

	async function send(batch: string[], my: number, attempt = 0): Promise<void> {
		if (!page) return;
		try {
			const r = await apiPost<{ tracks: Record<string, CatalogTrack[]> }>(`/api/catalog/artist/${page.artist.id}/appears`, { albums: batch });
			if (my !== gen) return;
			own = { ...own, ...r.tracks };
		} catch (e) {
			if (my !== gen) return;
			if (e instanceof ApiFailure && e.status === 429 && attempt < 5) {
				const s = e.retryAfterS ?? 5;
				waitS = s;
				await new Promise((r) => setTimeout(r, s * 1000));
				waitS = null;
				return send(batch, my, attempt + 1);
			}
			for (const a of batch) queued.delete(a);
			ownErr = { ...ownErr, ...Object.fromEntries(batch.map((a) => [a, true])) };
		}
	}

	const groups = $derived.by(() => {
		const out = {} as Record<ReleaseGroup, YearBlock<ReleaseWithState>[]>;
		const counts = {} as Record<ReleaseGroup, number>;
		for (const g of RELEASE_GROUPS) {
			const list = (page?.releases ?? []).filter((r) => r.group === g);
			counts[g] = list.length;
			out[g] = byYear(sortReleases(list, order));
		}
		return { blocks: out, counts };
	});
	const statsHref = $derived(page ? `/artist/${page.artist.id}?stats=1` : `/artist/${data.id}?stats=1`);
</script>

<svelte:head><title>Rotor · {page?.artist.name ?? 'Artist'}</title></svelte:head>

<div class="view" data-testid="artist-beta">
	<Header title="Artist" />
	{#if !mounted}
		<div class="skel" style="height:120px;border-radius:12px"></div>
	{:else if !flags.artistPages}
		<div class="off" data-testid="beta-off">
			<p>Artist pages (beta) are off on this device.</p>
			<div class="acts">
				<a class="btn sec" href="/artist/{data.id}">Open the artist's stats</a>
				<a class="btn ghost" href="/settings#h-exp">Settings › Experimental</a>
			</div>
		</div>
	{:else}
		{#if waitS !== null}
			<div class="bwrap"><Banner kind="warning"><span data-testid="rate-limited">Spotify is rate-limiting Rotor. Trying again in {waitS} s…</span></Banner></div>
		{/if}
		{#if error && !page}
			<p class="err" role="alert" data-testid="artist-error">{error}</p>
			<button class="btn sec" onclick={() => load(data.id)}>Try again</button>
		{:else if !page}
			<div aria-busy="true" aria-label="Loading artist" data-testid="artist-skeleton">
				<div class="hd"><div class="skel" style="width:120px;height:120px;border-radius:50%;flex:none"></div><div class="lines"><div class="skel" style="height:28px;width:60%"></div><div class="skel" style="height:14px;width:40%"></div></div></div>
				<div class="tiles">{#each [1, 2, 3, 4] as i (i)}<div class="skel" style="height:72px;border-radius:12px"></div>{/each}</div>
				{#each [1, 2, 3, 4, 5, 6] as i (i)}<div class="srow"><div class="skel" style="width:64px;height:64px;flex:none"></div><div class="lines"><div class="skel" style="height:14px;width:50%"></div><div class="skel" style="height:12px;width:35%"></div></div></div>{/each}
			</div>
		{:else}
			{@const a = page.artist}
			{@const m = page.mine}
			<header class="hd">
				<Art src={a.image} size={120} alt="" shape="circle" />
				<div class="lines">
					<span class="cap muted">Artist page · beta</span>
					<h1 class="ttl" data-testid="artist-name">{a.name}</h1>
					<div class="acts">
						<a class="btn sec" href={statsHref} data-testid="full-stats">Full stats & badges</a>
						<Attribution uri="spotify:artist:{a.id}" />
					</div>
				</div>
			</header>
			<div class="tiles" data-testid="mine">
				<StatTile label="Your plays" value={fmtInt(m.plays)} />
				<StatTile label="Hours" value={m.hours.toLocaleString('en-GB', { maximumFractionDigits: 1 })} />
				<StatTile label="Tracks played" value={fmtInt(m.tracks)} />
				<StatTile label="First played" value={m.firstPlayedAt ? fmtDate(m.firstPlayedAt) : '—'} small />
				<StatTile label="Last played" value={m.lastPlayedAt ? fmtDate(m.lastPlayedAt) : '—'} small />
			</div>
			{#if m.badges.length}
				<ul class="badges" aria-label="Your badges for {a.name}" data-testid="badges">
					{#each m.badges as b (b.type)}<li title={b.awardedAt ? `Since ${fmtDate(b.awardedAt)}` : ''}>{b.emoji} {b.label}</li>{/each}
				</ul>
			{:else if !m.plays}
				<p class="cap muted">You haven't played {a.name} yet.</p>
			{/if}
			{#if page.cache.stale}<p class="cap" style="color:var(--warning)">Spotify didn't answer: showing the discography as cached on {fmtDate(page.cache.fetchedAt)}.</p>{/if}

			<nav class="jump" aria-label="Discography sections">
				{#each RELEASE_GROUPS as g (g)}
					<a href="#g-{g}" data-testid="jump-{g}">{GROUP_LABEL[g]} <span class="n">{groups.counts[g]}</span></a>
				{/each}
				<div class="sort" role="radiogroup" aria-label="Sort releases">
					<button role="radio" aria-checked={order === 'newest'} class:on={order === 'newest'} onclick={() => (order = 'newest')} data-testid="sort-newest">Newest first</button>
					<button role="radio" aria-checked={order === 'oldest'} class:on={order === 'oldest'} onclick={() => (order = 'oldest')} data-testid="sort-oldest">Oldest first</button>
				</div>
			</nav>

			{#each RELEASE_GROUPS as g (g)}
				<section class="section grp" id="g-{g}" aria-labelledby="h-{g}" data-testid="group-{g}">
					<div class="sec-h"><h2 id="h-{g}">{GROUP_LABEL[g]}</h2><span class="cap muted">{groups.counts[g]} release{groups.counts[g] === 1 ? '' : 's'}</span></div>
					{#if !groups.counts[g]}
						<p class="cap muted">None on Spotify.</p>
					{/if}
					{#each groups.blocks[g] as block (block.year)}
						<h3 class="year" data-testid="year">{block.year}</h3>
						{#each block.items as r (r.id)}
							<ReleaseCard release={r} artist={{ id: a.id, name: a.name }} own={g === 'appears_on' ? own[r.id] : undefined} ownError={!!ownErr[r.id]} onvisible={g === 'appears_on' ? want : undefined} />
						{/each}
					{/each}
				</section>
			{/each}
			<p class="cap muted foot">Discography from Spotify, cached for 7 days when you open an artist. Plays, hours, liked and badges are your own data.</p>
		{/if}
	{/if}
</div>

<style>
	.hd {
		display: flex;
		gap: 16px;
		align-items: center;
		margin: 4px 0 16px;
	}
	.lines {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ttl {
		font-size: 30px;
		font-weight: 800;
		margin: 0;
		line-height: 1.1;
	}
	.acts {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		align-items: center;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
		gap: 10px;
		margin-bottom: 12px;
	}
	.tiles :global(.tile) {
		width: auto;
	}
	.badges {
		list-style: none;
		padding: 0;
		margin: 0 0 12px;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.badges li {
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 5px 10px;
		font-size: 12px;
	}
	.jump {
		position: sticky;
		top: calc(var(--safe-top) + 52px);
		z-index: 4;
		background: var(--bg);
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 8px 0;
		margin-top: 8px;
		border-bottom: 1px solid var(--border);
	}
	.jump a {
		background: var(--surface-2);
		color: var(--text-1);
		border-radius: var(--r-pill);
		padding: 6px 12px;
		font-size: 13px;
		font-weight: 700;
	}
	.jump .n {
		color: var(--text-3);
		font-weight: 600;
	}
	.sort {
		margin-left: auto;
		display: inline-flex;
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 2px;
	}
	.sort button {
		font-size: 12px;
		font-weight: 700;
		padding: 5px 10px;
		border-radius: var(--r-pill);
		color: var(--text-2);
	}
	.sort button.on {
		background: var(--surface-4);
		color: var(--text-1);
	}
	.grp {
		scroll-margin-top: 120px;
	}
	.year {
		font-size: 13px;
		font-weight: 800;
		color: var(--text-3);
		margin: 14px 0 0;
		letter-spacing: 0.04em;
	}
	.srow {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 10px 0;
	}
	.off {
		padding: 16px 0;
	}
	.err {
		color: var(--danger);
	}
	.bwrap {
		margin-bottom: 10px;
	}
	.foot {
		margin-top: 24px;
	}
</style>
