<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { library } from '$lib/stores/library.svelte';
	import { ownPlayer, trackItem } from '$lib/stores/own-player.svelte';
	import { STATUS_LABEL, artistLine, displayTitle, fmtClock, listKey, ownKey, type OwnTrack, type RotorList } from '$lib/shared/own';
	import { moveTargets } from '$lib/shared/library';

	/**
	 * Library › Own & IDs (v0.94): your own tracks and Rotor-only lists. Pins and folders work like the
	 * rest of the Library (0034), but this space stays apart from Spotify: a folder's Spotify view shows
	 * its playlists, its view here shows your own items. Nothing here ever reaches Spotify.
	 */
	let tracks = $state<OwnTrack[] | null>(null);
	let lists = $state<RotorList[]>([]);
	let error = $state<string | null>(null);
	let q = $state('');

	async function load() {
		try {
			const [t, l] = await Promise.all([apiGet<{ tracks: OwnTrack[] }>('/api/own'), apiGet<{ lists: RotorList[] }>('/api/own/lists')]);
			tracks = t.tracks;
			lists = l.lists;
		} catch (e) {
			error = describeFailure(e);
			tracks = [];
		}
	}
	$effect(() => {
		void load();
		if (!library.loaded) void library.loadOrg();
	});

	type Row = { key: string; kind: 'own'; t: OwnTrack } | { key: string; kind: 'list'; l: RotorList };
	const item = (key: string) => library.org.items.find((i) => i.key === key);
	const rows = $derived.by<Row[]>(() => {
		const term = q.trim().toLowerCase();
		const ls: Row[] = lists.filter((l) => !term || l.name.toLowerCase().includes(term)).map((l) => ({ key: listKey(l.id), kind: 'list', l }));
		const ts: Row[] = (tracks ?? [])
			.filter((t) => !term || `${t.title} ${t.version ?? ''} ${artistLine(t.artists.primary)} ${t.label ?? ''}`.toLowerCase().includes(term))
			.map((t) => ({ key: ownKey(t.id), kind: 'own', t }));
		return [...ls, ...ts];
	});
	const pinned = $derived(rows.filter((r) => item(r.key)?.pinPos != null).sort((a, b) => item(a.key)!.pinPos! - item(b.key)!.pinPos!));
	const folders = $derived(
		library.org.folders
			.map((f) => ({ f, rows: rows.filter((r) => item(r.key)?.folderId === f.id && item(r.key)?.pinPos == null) }))
			.filter((g) => g.rows.length)
	);
	const rest = $derived(rows.filter((r) => item(r.key)?.pinPos == null && (item(r.key)?.folderId == null || !library.org.folders.some((f) => f.id === item(r.key)?.folderId))));

	async function togglePin(r: Row) {
		const on = item(r.key)?.pinPos == null;
		try {
			await library.organise('/api/library/pin', { targets: [r.key], pinned: on });
			toasts.show(on ? 'Pinned · in Rotor only' : 'Unpinned');
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	let moving = $state<Row | null>(null);
	async function moveTo(folderId: number | null) {
		const r = moving;
		moving = null;
		if (!r) return;
		try {
			await library.organise('/api/library/move', { keys: [r.key], folderId });
			toasts.show(folderId === null ? 'Back in Own & IDs' : `Moved to ${library.org.folders.find((f) => f.id === folderId)?.name ?? 'folder'} · in Rotor only`);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	let newList = $state('');
	async function createList(e: SubmitEvent) {
		e.preventDefault();
		try {
			await apiPost('/api/own/lists', { name: newList });
			newList = '';
			await load();
			toasts.show('Rotor list created · never a Spotify playlist');
		} catch (err) {
			toasts.error(describeFailure(err));
		}
	}
	function play(t: OwnTrack) {
		const it = trackItem(t);
		if (it) void ownPlayer.play([it]);
	}
</script>

<section class="own" aria-label="Own tracks and IDs" data-testid="own-library">
	<p class="cap muted">Unreleased tracks and IDs you keep in Rotor, with Rotor-only lists. Never added to a Spotify playlist.</p>
	<div class="bar">
		<a class="btn pri" href="/own/new" data-testid="own-add"><Icon name="plus" size={16} /> Add track</a>
		<input type="search" bind:value={q} placeholder="Filter own tracks" aria-label="Filter own tracks" />
	</div>

	{#if error}<p class="notice" role="alert">{error}</p>{/if}
	{#snippet row(r: Row)}
		<li data-testid={r.kind === 'own' ? 'own-row' : 'list-row'} data-key={r.key}>
			{#if r.kind === 'own'}
				<a href="/own/{r.t.id}" class="main">
					{#if r.t.cover}<img src={r.t.cover} alt="" width="48" height="48" loading="lazy" referrerpolicy="no-referrer" />{:else}<span class="ph"><Icon name="note" size={20} /></span>{/if}
					<span class="t">
						<b class="ell">{displayTitle(r.t)}</b>
						<span class="cap muted ell">{artistLine(r.t.artists.primary)} · {fmtClock(r.t.durationMs)} · {r.t.plays} Rotor play{r.t.plays === 1 ? '' : 's'}</span>
					</span>
					<span class="badge">{STATUS_LABEL[r.t.status]}</span>
				</a>
				{#if r.t.audio}<button class="ibtn" aria-label="Play {r.t.title} in Rotor" onclick={() => play(r.t)}><Icon name="play" size={16} /></button>{/if}
			{:else}
				<a href="/own/lists/{r.l.id}" class="main">
					<span class="ph"><Icon name="list" size={20} /></span>
					<span class="t"><b class="ell">{r.l.name}</b><span class="cap muted">Rotor list · {r.l.count} track{r.l.count === 1 ? '' : 's'}</span></span>
				</a>
			{/if}
			{#if !library.orgError}
				<button class="ibtn" class:on={item(r.key)?.pinPos != null} aria-pressed={item(r.key)?.pinPos != null} aria-label="{item(r.key)?.pinPos != null ? 'Unpin' : 'Pin'}" onclick={() => togglePin(r)}><Icon name="pin" size={16} /></button>
				<button class="ibtn" aria-label="Move to a folder" onclick={() => (moving = r)}><Icon name="folder" size={16} /></button>
			{/if}
		</li>
	{/snippet}

	{#if tracks === null}
		<div class="skel" style="height:64px;margin-top:12px;border-radius:8px"></div>
	{:else if !rows.length}
		<p class="muted empty">{q ? 'Nothing matches.' : 'No own tracks yet. Add your first unreleased track or ID.'}</p>
	{:else}
		{#if pinned.length}
			<p class="cap muted h"><Icon name="pin" size={12} /> Pinned · in Rotor only</p>
			<ul class="list" data-testid="own-pinned">{#each pinned as r (r.key)}{@render row(r)}{/each}</ul>
		{/if}
		{#each folders as g (g.f.id)}
			<p class="cap muted h"><Icon name="folder" size={12} /> {g.f.name}</p>
			<ul class="list" data-testid="own-folder">{#each g.rows as r (r.key)}{@render row(r)}{/each}</ul>
		{/each}
		<ul class="list">{#each rest as r (r.key)}{@render row(r)}{/each}</ul>
	{/if}

	<form class="newlist" onsubmit={createList}>
		<label class="sr" for="nl">New Rotor list</label>
		<input id="nl" bind:value={newList} placeholder="New Rotor list (own tracks only)" maxlength="100" />
		<button class="btn sec" type="submit" disabled={!newList.trim()}>Create list</button>
	</form>
</section>

<Sheet open={!!moving} onclose={() => (moving = null)} label="Move to a folder">
	<div class="sheet">
		<h2>Move to a folder</h2>
		<p class="cap muted">Folders are shared with your Spotify Library; this item shows in the folder’s Own & IDs view only.</p>
		<button class="btn ghost" onclick={() => moveTo(null)}>No folder</button>
		{#each moveTargets(library.org) as t (t.id)}
			<button class="btn ghost" style:padding-left="{18 + t.depth * 16}px" onclick={() => moveTo(t.id)}>{t.name}</button>
		{/each}
		{#if !library.org.folders.length}<p class="cap muted">No folders yet: create one in the Spotify view (+ › New folder).</p>{/if}
	</div>
</Sheet>

<style>
	.bar,
	.newlist {
		display: flex;
		gap: 8px;
		margin: 10px 0;
		align-items: center;
	}
	.bar input,
	.newlist input {
		flex: 1;
		min-width: 0;
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		padding: 10px 16px;
		font: inherit;
	}
	.list {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
	}
	.list li {
		display: flex;
		align-items: center;
		gap: 4px;
		border-bottom: 1px solid var(--border);
	}
	.main {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
		color: var(--text-1);
		min-height: 64px;
		flex: 1;
		min-width: 0;
	}
	.main img,
	.ph {
		width: 48px;
		height: 48px;
		border-radius: 4px;
		object-fit: cover;
		flex: none;
		background: var(--surface-3);
		display: grid;
		place-items: center;
		color: var(--text-3);
	}
	.t {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.h {
		margin: 14px 0 0;
		display: flex;
		gap: 4px;
		align-items: center;
	}
	.ibtn.on {
		color: var(--accent);
	}
	.empty {
		padding: 16px 0;
	}
	.sheet {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 4px;
	}
	.sheet .btn {
		justify-content: flex-start;
	}
</style>
