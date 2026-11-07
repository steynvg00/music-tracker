<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import LibraryRowItem from '$lib/components/LibraryRowItem.svelte';
	import { customSheet } from '$lib/components/custom-playlist-sheet/store.svelte';
	import { library } from '$lib/stores/library.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Collections from '$lib/components/elsewhere/Collections.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { CHIPS, CHIP_LABEL, SORTS, SORT_LABEL, filterRows, groupByCategory, sortRows, type Chip, type LibrarySort } from '$lib/shared/library';

	let { data } = $props();
	const KEY = 'rotor.library';
	const SOURCE_KEY = 'rotor.library.source';
	type LibSource = 'spotify' | 'youtube' | 'soundcloud';
	const SOURCES: { key: LibSource; label: string }[] = [
		{ key: 'spotify', label: 'Spotify' },
		{ key: 'youtube', label: 'YouTube' },
		{ key: 'soundcloud', label: 'SoundCloud' }
	];
	let source = $state<LibSource>('spotify');
	/** Exclusive: there is no "All" view, so Spotify never shares a list with YouTube/SoundCloud. */
	function pickSource(s: LibSource) {
		source = s;
		try {
			localStorage.setItem(SOURCE_KEY, s);
		} catch {
			/* private mode */
		}
		const u = new URL(page.url);
		if (s === 'spotify') u.searchParams.delete('source');
		else u.searchParams.set('source', s);
		void goto(u.pathname + u.search, { replaceState: true, keepFocus: true, noScroll: true });
	}
	let chips = $state<Set<Chip>>(new Set());
	let sort = $state<LibrarySort>('az');

	onMount(() => {
		const q = page.url.searchParams.get('source');
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(SOURCE_KEY);
		} catch {
			/* private mode */
		}
		const want = (q ?? saved) as LibSource | null;
		if (want && SOURCES.some((x) => x.key === want)) source = want;
		try {
			const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { chips?: Chip[]; sort?: LibrarySort };
			chips = new Set((saved.chips ?? []).filter((c) => CHIPS.includes(c)));
			if (saved.sort && SORTS.includes(saved.sort)) sort = saved.sort;
		} catch {
			/* first visit */
		}
		void library.load();
	});

	function persist() {
		try {
			localStorage.setItem(KEY, JSON.stringify({ chips: [...chips], sort }));
		} catch {
			/* private mode */
		}
	}
	function toggle(c: Chip) {
		const next = new Set(chips);
		if (next.has(c)) next.delete(c);
		else next.add(c);
		chips = next;
		persist();
	}

	const visible = $derived(sortRows(filterRows(library.rows, chips), sort));
	const showLiked = $derived(chips.size === 0 || chips.has('liked'));
	const grouped = $derived(chips.size === 1 && chips.has('managed') ? groupByCategory(visible, library.categories) : null);
	const likedUri = $derived(`spotify:user:${data.ownerId}:collection`);
</script>

<svelte:head><title>Rotor · Library</title></svelte:head>

<div class="view">
	<Header title="Library" />
	<div class="srcsw" role="tablist" aria-label="Source">
		{#each SOURCES as x (x.key)}
			<button role="tab" aria-selected={source === x.key} class:on={source === x.key} onclick={() => pickSource(x.key)}>{x.label}</button>
		{/each}
	</div>
	{#if source !== 'spotify'}
		{#key source}<Collections {source} />{/key}
	{:else}
	<div class="actions">
		<button class="btn pri" onclick={() => customSheet.openCreate()}><Icon name="plus" size={18} /> New custom playlist</button>
		<a class="btn sec" href="/rules">Rules</a>
		<a class="btn sec" href="/radar">Release radar</a>
		<a class="btn sec" href="/digest">This week</a>
	</div>
	<div class="chips" role="group" aria-label="Filter">
		{#each CHIPS as c (c)}
			<button class="chip" class:on={chips.has(c)} aria-pressed={chips.has(c)} onclick={() => toggle(c)}>{CHIP_LABEL[c]}</button>
		{/each}
	</div>
	<div class="sortline">
		<label for="lib-sort" class="cap">Sort</label>
		<select id="lib-sort" class="select" bind:value={sort} onchange={persist}>
			{#each SORTS as s (s)}<option value={s}>{SORT_LABEL[s]}</option>{/each}
		</select>
		<span class="cap muted">{visible.length} playlists</span>
	</div>

	{#if showLiked && !library.error}
		<button class="liked" onclick={() => (player.view.context?.uri === likedUri ? player.togglePlay() : player.playContext(likedUri, 'Liked Songs'))}>
			<span class="art s heart"><Icon name="play" size={22} /></span>
			<span class="grow"><b>Liked Songs</b><span class="cap">Tap to play · read & play</span></span>
		</button>
	{/if}
	{#if library.error}
		<p class="notice">{library.error}</p>
	{:else if !library.loaded}
		<!-- R8: skeleton rows from the first (server) render until the list arrives: no "Nothing here" flash, no jump. -->
		<div class="list" data-testid="skeleton" aria-busy="true" aria-label="Loading playlists">
			{#each [1, 2, 3, 4, 5, 6, 7, 8] as i (i)}<div class="skelrow"><div class="skel" style="width:56px;height:56px;flex:none"></div><div class="skelt"><div class="skel" style="height:14px;width:55%"></div><div class="skel" style="height:12px;width:35%"></div></div></div>{/each}
		</div>
	{:else}
		{#if grouped}
			{#each grouped as g (g.key)}
				<section class="group">
					<div class="ghead"><h2>{g.name}</h2><a class="cap" href="/rules#{g.key}">Rule</a></div>
					{#each g.rows as r (r.id)}<LibraryRowItem {r} />{/each}
				</section>
			{/each}
		{:else}
			<div class="list">{#each visible as r (r.id)}<LibraryRowItem {r} />{/each}</div>
		{/if}
		{#if !visible.length && !showLiked}<p class="cap muted empty">Nothing here with these filters.</p>{/if}
	{/if}
	{/if}
</div>

<style>
	.srcsw {
		display: inline-flex;
		background: var(--surface-2);
		border-radius: var(--r-pill);
		padding: 3px;
		margin: 4px 0 12px;
	}
	.srcsw button {
		padding: 7px 16px;
		border-radius: var(--r-pill);
		color: var(--text-2);
		font-weight: 600;
		min-height: 36px;
	}
	.srcsw button.on {
		background: var(--accent);
		color: var(--on-accent);
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 4px 0 14px;
	}
	.chips {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		scrollbar-width: none;
		padding: 2px 0;
	}
	.chip {
		height: 32px;
		padding: 0 14px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		font-size: 13px;
		font-weight: 650;
		white-space: nowrap;
		border: 1px solid transparent;
		flex: none;
	}
	.chip.on {
		background: var(--accent-subtle);
		border-color: var(--accent);
	}
	.sortline {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 12px 0 6px;
	}
	.select {
		height: 32px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		color: var(--text-1);
		border: 0;
		padding: 0 12px;
		font: inherit;
		font-size: 13px;
	}
	.liked {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		text-align: left;
		min-height: 64px;
		padding: 4px 0;
	}
	.heart {
		width: 56px;
		height: 56px;
		display: grid;
		place-items: center;
		color: #fff;
		background: linear-gradient(135deg, #6d4bd8, #9fd7e8);
	}
	.liked .grow {
		display: flex;
		flex-direction: column;
	}
	.group {
		margin-top: 18px;
	}
	.ghead {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 4px;
	}
	.ghead h2 {
		font-size: 16px;
		font-weight: 800;
	}
	.ghead a {
		text-decoration: underline;
	}
	/* Same box as a LibraryRowItem row (min-height 64px, 4px 8px padding, 12px gap). */
	.skelrow {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 4px 8px;
	}
	.skelt {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.empty {
		margin-top: 24px;
	}
</style>
