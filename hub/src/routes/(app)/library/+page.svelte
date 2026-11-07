<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import PillBar from '$lib/components/PillBar.svelte';
	import OptionSheet from '$lib/components/OptionSheet.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import EntryRow from '$lib/components/library/EntryRow.svelte';
	import Collections from '$lib/components/elsewhere/Collections.svelte';
	import { customSheet } from '$lib/components/custom-playlist-sheet/store.svelte';
	import { sortable } from '$lib/actions/sortable';
	import { library } from '$lib/stores/library.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { apiPost, describeFailure } from '$lib/player/api-client';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { PillGroup } from '$lib/shared/pills';
	import {
		KINDS,
		KIND_LABEL,
		LIB_SOURCES,
		MAX_FOLDER_NAME,
		SORTS,
		SORT_LABEL,
		folderTarget,
		libraryView,
		moveTargets,
		reorder,
		type Entry,
		type LibKind,
		type LibrarySort,
		type LibSource,
		type LibView
	} from '$lib/shared/library';

	let { data } = $props();
	const PREFS = 'rotor.library.v2';
	const likedUri = $derived(`spotify:user:${data.ownerId}:collection`);

	// ── filters (one pill bar) ──
	let source = $state<LibSource | null>(null); // null = Spotify (there is no "All": Spotify never shares a list with YouTube/SoundCloud)
	let kind = $state<LibKind | null>(null);
	let sort = $state<LibrarySort>('az');
	let view = $state<LibView>('list');
	let ready = $state(false);
	let manage = $state(false);
	let q = $state('');
	let searchOpen = $state(false);
	let searchEl = $state<HTMLInputElement | null>(null);
	const src = $derived<LibSource>(source ?? 'spotify');
	const folderId = $derived.by(() => {
		const n = Number(page.url.searchParams.get('folder'));
		return Number.isInteger(n) && n > 0 ? n : null;
	});

	onMount(() => {
		try {
			const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { source?: LibSource | null; kind?: LibKind | null; sort?: LibrarySort; view?: LibView };
			if (p.kind && (KINDS as readonly string[]).includes(p.kind)) kind = p.kind;
			if (p.sort && (SORTS as readonly string[]).includes(p.sort)) sort = p.sort;
			if (p.view === 'grid' || p.view === 'list') view = p.view;
			if (p.source && p.source !== 'spotify' && LIB_SOURCES.some((s) => s.key === p.source)) source = p.source;
			// Saved by v0.84–v0.90 as its own key.
			const old = localStorage.getItem('rotor.library.source') as LibSource | null;
			if (!p.source && old && old !== 'spotify') source = old;
		} catch {
			/* first visit / private mode */
		}
		const qs = page.url.searchParams.get('source') as LibSource | null;
		if (qs && LIB_SOURCES.some((s) => s.key === qs)) source = qs === 'spotify' ? null : qs;
		ready = true;
		void library.load();
	});
	function persist() {
		try {
			localStorage.setItem(PREFS, JSON.stringify({ source, kind, sort, view }));
			localStorage.removeItem('rotor.library.source');
		} catch {
			/* private mode */
		}
	}
	function setSource(s: LibSource | null) {
		source = s;
		manage = false;
		persist();
		const u = new URL(page.url);
		if (!s || s === 'spotify') u.searchParams.delete('source');
		else u.searchParams.set('source', s);
		u.searchParams.delete('folder');
		void goto(u.pathname + u.search, { replaceState: true, keepFocus: true, noScroll: true });
	}
	const groups = $derived<PillGroup[]>([
		{ key: 'source', label: 'Source', options: LIB_SOURCES.map((s) => ({ value: s.key, label: s.label })), value: source, collapse: true },
		{
			key: 'kind',
			label: 'Kind',
			options: KINDS.filter((k) => !library.orgError || (k !== 'pinned' && k !== 'folders')).map((k) => ({ value: k, label: KIND_LABEL[k] })),
			value: kind,
			collapse: true,
			hidden: src !== 'spotify'
		}
	]);
	function onpick(group: string, value: string | null) {
		if (group === 'source') return setSource(value as LibSource | null);
		kind = value as LibKind | null;
		if (folderId) void goto('/library', { replaceState: true, keepFocus: true, noScroll: true });
		persist();
	}
	function clearAll() {
		kind = null;
		setSource(null);
	}
	async function toggleSearch() {
		searchOpen = !searchOpen || !!q;
		if (searchOpen) {
			await tick();
			searchEl?.focus();
		}
	}

	// ── what's shown ──
	const model = $derived(libraryView({ rows: library.rows, org: library.org, kind, sort, folderId, q, categories: library.categories }));
	const total = $derived(model.pinned.length + model.entries.length);
	const pinDrag = $derived(!kind && !q && !folderId && !manage);
	const orderDrag = $derived(sort === 'custom' && !kind && !q && !manage && !library.orgError);

	// ── manage mode ──
	let selected = $state<Set<string>>(new Set());
	function toggleManage() {
		manage = !manage;
		selected = new Set();
	}
	function toggle(key: string) {
		const next = new Set(selected);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		selected = next;
	}
	const allEntries = $derived([...model.pinned, ...model.entries]);
	/** In the order you tapped them (pins are added in that order). */
	const selEntries = $derived([...selected].map((k) => allEntries.find((e) => e.key === k)).filter((e): e is Entry => !!e));
	const selItems = $derived(selEntries.filter((e) => e.type !== 'folder').map((e) => e.key));
	const selFolders = $derived(selEntries.filter((e): e is Extract<Entry, { type: 'folder' }> => e.type === 'folder'));
	const allPinned = $derived(selEntries.length > 0 && selEntries.every((e) => e.pinned));
	/** Extend / keep / delete only when EVERY selected entry is one of your Custom 🎧 playlists (guarded server-side too). */
	const selCustom = $derived(selEntries.length > 0 && selEntries.every((e) => e.type === 'playlist' && e.row.kind === 'custom' && e.row.isOwned));
	let busy = $state(false);

	async function run(label: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = true;
		try {
			await fn();
			toasts.show(label);
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			busy = false;
		}
	}
	const pinSelected = (pinned: boolean) =>
		run(pinned ? `Pinned ${selEntries.length} · in Rotor only` : `Unpinned ${selEntries.length}`, async () => {
			await library.organise('/api/library/pin', { targets: selEntries.map((e) => e.key), pinned });
			selected = new Set();
		});
	async function reorderPinned(from: number, to: number) {
		const keys = reorder(
			model.pinned.map((e) => e.key),
			from,
			to
		);
		await run('Pinned order saved', () => library.organise('/api/library/pins', { targets: keys }, 'PUT'));
	}
	async function reorderLevel(from: number, to: number) {
		const keys = reorder(
			model.entries.map((e) => e.key),
			from,
			to
		);
		await run('Order saved', () => library.organise('/api/library/order', { folderId, targets: keys }, 'PUT'));
	}
	function customAction(action: 'extend' | 'keep') {
		void run(action === 'extend' ? 'Extended by 7 days' : 'Kept', async () => {
			for (const e of selEntries) if (e.type === 'playlist') await apiPost(`/api/custom/${e.row.id}`, { action });
			library.invalidate();
			selected = new Set();
		});
	}
	let confirmDelete = $state(false);
	function deleteCustom() {
		confirmDelete = false;
		void run(`Deleted ${selEntries.length} custom playlist${selEntries.length === 1 ? '' : 's'}`, async () => {
			for (const e of selEntries) if (e.type === 'playlist') await apiPost(`/api/custom/${e.row.id}`, { action: 'delete' });
			library.invalidate();
			selected = new Set();
		});
	}

	// ── folders ──
	let folderSheet = $state<{ mode: 'create' | 'rename'; id: number | null; name: string; parentId: number | null; moveAfter: string[] } | null>(null);
	let confirmFolder = $state<{ id: number; name: string } | null>(null);
	const topFolders = $derived(library.org.folders.filter((f) => f.parentId === null));
	function newFolder(moveAfter: string[] = []) {
		plusOpen = false;
		moveOpen = false;
		folderSheet = { mode: 'create', id: null, name: '', parentId: folderId && !model.parent && model.folder ? model.folder.id : null, moveAfter };
	}
	function renameFolder(id: number, name: string) {
		folderSheet = { mode: 'rename', id, name, parentId: null, moveAfter: [] };
	}
	async function saveFolder(e: SubmitEvent) {
		e.preventDefault();
		const f = folderSheet;
		if (!f) return;
		await run(f.mode === 'create' ? `Folder “${f.name.trim()}” created · in Rotor only` : 'Folder renamed', async () => {
			if (f.mode === 'create') {
				const r = await apiPost<{ folder: { id: number } }>('/api/library/folders', { name: f.name, parentId: f.parentId });
				if (f.moveAfter.length) await library.organise('/api/library/move', { keys: f.moveAfter, folderId: r.folder.id });
				else await library.loadOrg();
				selected = new Set();
			} else {
				await fetchJson(`/api/library/folders/${f.id}`, 'PATCH', { name: f.name });
				await library.loadOrg();
			}
			folderSheet = null;
		});
	}
	async function removeFolder() {
		const f = confirmFolder;
		confirmFolder = null;
		if (!f) return;
		await run(`Folder “${f.name}” deleted: its playlists are back in your Library`, async () => {
			await fetchJson(`/api/library/folders/${f.id}`, 'DELETE');
			await library.loadOrg();
			if (folderId === f.id) await goto('/library', { replaceState: true });
		});
	}
	async function fetchJson(path: string, method: 'PATCH' | 'DELETE', body?: unknown) {
		const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
		if (!res.ok) {
			const b = (await res.json().catch(() => ({}))) as { message?: string };
			throw new Error(b.message ?? `HTTP ${res.status}`);
		}
		return res.json();
	}

	// ── move to folder ──
	let moveOpen = $state(false);
	const targets = $derived(moveTargets(library.org));
	async function moveTo(target: number | null) {
		moveOpen = false;
		const name = target === null ? 'your Library' : (library.org.folders.find((f) => f.id === target)?.name ?? 'the folder');
		await run(`Moved to ${name} · in Rotor only`, async () => {
			if (selItems.length) await library.organise('/api/library/move', { keys: selItems, folderId: target });
			for (const f of selFolders) if (f.folder.id !== target) await fetchJson(`/api/library/folders/${f.folder.id}`, 'PATCH', { parentId: target });
			await library.loadOrg();
			selected = new Set();
		});
	}

	// ── + menu, sort & view ──
	let plusOpen = $state(false);
	let sortOpen = $state(false);
</script>

<svelte:head><title>Rotor · Library</title></svelte:head>

<div class="view" data-testid="library">
	<Header title="Library">
		{#snippet actions()}
			<button class="ibtn" class:on={searchOpen || !!q} aria-label="Search your Library" aria-expanded={searchOpen || !!q} onclick={toggleSearch} data-testid="lib-search-toggle"><Icon name="search" size={20} /></button>
			{#if src === 'spotify'}
				<button class="ibtn" aria-label="New custom playlist or folder" aria-haspopup="dialog" onclick={() => (plusOpen = true)} data-testid="lib-plus"><Icon name="plus" size={22} /></button>
				<button class="btn ghost sm" class:on={manage} aria-pressed={manage} onclick={toggleManage} data-testid="lib-manage">{manage ? 'Done' : 'Manage'}</button>
			{/if}
		{/snippet}
	</Header>

	{#if searchOpen || q}
		<form role="search" class="search" onsubmit={(e) => e.preventDefault()}>
			<label class="sr" for="lib-q">Filter your Library</label>
			<input id="lib-q" type="search" bind:this={searchEl} bind:value={q} placeholder="Filter playlists and folders" autocomplete="off" data-testid="lib-q" />
		</form>
	{/if}

	<PillBar
		label="Library filters"
		{groups}
		{onpick}
		onclear={clearAll}
		{ready}
		action={src === 'spotify' ? { label: `Sort and view: ${SORT_LABEL[sort]}, ${view}`, icon: view === 'grid' ? 'grid' : 'sort', onclick: () => (sortOpen = true), active: sort !== 'az' || view !== 'list' } : undefined}
		testid="lib-pills"
	/>

	{#if src !== 'spotify'}
		{#key src}<Collections source={src} />{/key}
	{:else}
		{#if manage}
			<p class="note" role="note" data-testid="rotor-only">Pins and folders live in Rotor only: nothing changes in Spotify. Extend, keep and delete work on your Custom 🎧 playlists only.</p>
		{/if}
		{#if library.orgError && ready && library.loaded}<p class="cap muted">{library.orgError}</p>{/if}

		{#if library.error}
			<p class="notice">{library.error}</p>
		{:else if !library.loaded}
			<!-- R8: skeleton rows from the first (server) render until the list arrives: no "Nothing here" flash, no jump. -->
			<div class="list" data-testid="skeleton" aria-busy="true" aria-label="Loading playlists">
				{#each [1, 2, 3, 4, 5, 6, 7, 8] as i (i)}<div class="skelrow"><div class="skel" style="width:56px;height:56px;flex:none"></div><div class="skelt"><div class="skel" style="height:14px;width:55%"></div><div class="skel" style="height:12px;width:35%"></div></div></div>{/each}
			</div>
		{:else}
			{#if model.folder}
				<nav class="crumbs" aria-label="Folder" data-testid="crumbs">
					<a href="/library"><Icon name="back" size={16} /> Library</a>
					{#if model.parent}<span>›</span><a href="/library?folder={model.parent.id}">{model.parent.name}</a>{/if}
					<span>›</span><h2 data-testid="folder-name">{model.folder.name}</h2>
					<span class="grow"></span>
					<button class="ibtn sm" aria-label="Rename folder" onclick={() => renameFolder(model.folder!.id, model.folder!.name)} data-testid="folder-rename"><Icon name="more" size={18} /></button>
					<button class="btn ghost sm" onclick={() => (confirmFolder = { id: model.folder!.id, name: model.folder!.name })} data-testid="folder-delete">Delete folder</button>
				</nav>
			{/if}

			{#if model.pinned.length}
				<section class="pinned" aria-labelledby="h-pinned" data-testid="pinned">
					<div class="ghead"><h2 id="h-pinned"><Icon name="pin" size={14} /> Pinned</h2><span class="cap muted">in Rotor only · drag to reorder</span></div>
					<div class={view === 'grid' ? 'grid' : 'list'} use:sortable={{ onreorder: reorderPinned, disabled: !pinDrag || view === 'grid' }}>
						{#each model.pinned as e, i (e.key)}
							<div class="slot" data-sort-index={i}><EntryRow {e} {view} {manage} selected={selected.has(e.key)} handle={pinDrag} {likedUri} ontoggle={toggle} /></div>
						{/each}
					</div>
				</section>
			{/if}

			{#if model.groups}
				<p class="cap"><a href="/rules" data-testid="all-rules">All playlist rules ›</a></p>
				{#each model.groups as g (g.key)}
					<section class="group">
						<div class="ghead"><h2>{g.name}</h2><a class="cap" href="/rules#{g.key}">Rule</a></div>
						<div class={view === 'grid' ? 'grid' : 'list'}>
							{#each g.rows as r (r.id)}
								{@const e = model.entries.find((x) => x.type === 'playlist' && x.row.id === r.id)!}
								<EntryRow {e} {view} {manage} selected={selected.has(e.key)} {likedUri} ontoggle={toggle} />
							{/each}
						</div>
					</section>
				{/each}
			{:else}
				{#if model.pinned.length && model.entries.length}<div class="ghead rest"><h2>{model.folder ? 'In this folder' : 'Your Library'}</h2><span class="cap muted">{model.entries.length}</span></div>{/if}
				<div class={view === 'grid' ? 'grid' : 'list'} use:sortable={{ onreorder: reorderLevel, disabled: !orderDrag || view === 'grid' }} data-testid="entries">
					{#each model.entries as e, i (e.key)}
						<div class="slot" data-sort-index={i}><EntryRow {e} {view} {manage} selected={selected.has(e.key)} handle={orderDrag} {likedUri} ontoggle={toggle} /></div>
					{/each}
				</div>
			{/if}
			{#if !total}<p class="cap muted empty">{q ? `Nothing in your Library matches “${q}”.` : model.folder ? 'This folder is empty. Use Manage › Move to folder to add playlists.' : 'Nothing here with this filter.'}</p>{/if}
		{/if}
	{/if}
</div>

{#if manage && src === 'spotify'}
	<div class="managebar" role="toolbar" aria-label="Selected playlists" data-testid="managebar">
		<span class="cnt" aria-live="polite">{selEntries.length} selected</span>
		{#if !library.orgError}
			<button class="btn sec sm" disabled={!selEntries.length || busy} onclick={() => pinSelected(!allPinned)} data-testid="m-pin">{allPinned ? 'Unpin' : 'Pin'}</button>
			<button class="btn sec sm" disabled={!selEntries.length || busy} onclick={() => (moveOpen = true)} data-testid="m-move">Move to folder</button>
			{#if selFolders.length === 1 && selEntries.length === 1}
				<button class="btn sec sm" disabled={busy} onclick={() => renameFolder(selFolders[0]!.folder.id, selFolders[0]!.folder.name)} data-testid="m-rename">Rename</button>
				<button class="btn sec sm" disabled={busy} onclick={() => (confirmFolder = { id: selFolders[0]!.folder.id, name: selFolders[0]!.folder.name })} data-testid="m-delete-folder">Delete folder</button>
			{/if}
		{/if}
		{#if selCustom}
			<button class="btn sec sm" disabled={busy} onclick={() => customAction('extend')} data-testid="m-extend">Extend +7 d</button>
			<button class="btn sec sm" disabled={busy} onclick={() => customAction('keep')} data-testid="m-keep">Keep</button>
			<button class="btn danger sm" disabled={busy} onclick={() => (confirmDelete = true)} data-testid="m-delete">Delete</button>
		{/if}
	</div>
{/if}

<OptionSheet
	open={sortOpen}
	onclose={() => (sortOpen = false)}
	title="Sort & view"
	sections={[
		{ key: 'sort', title: 'Sort by', options: SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] })), value: sort, onselect: (v) => ((sort = v as LibrarySort), persist()) },
		{ key: 'view', title: 'View', options: [{ value: 'list', label: 'List' }, { value: 'grid', label: 'Grid' }], value: view, onselect: (v) => ((view = v as LibView), persist()) }
	]}
>
	{#if sort === 'custom'}<p class="cap muted">Custom order: drag the handles (long-press on a phone). Rotor only.</p>{/if}
</OptionSheet>

<Sheet open={plusOpen} onclose={() => (plusOpen = false)} label="Create">
	<h2 class="st">Create</h2>
	<button class="opt" onclick={() => ((plusOpen = false), customSheet.openCreate())} data-testid="plus-custom"><Icon name="plus" size={18} /> New custom playlist <span class="cap muted">· on Spotify, with the Custom 🎧 suffix</span></button>
	<button class="opt" disabled={!!library.orgError} onclick={() => newFolder()} data-testid="plus-folder"><Icon name="folder" size={18} /> New folder <span class="cap muted">· in Rotor only</span></button>
</Sheet>

<Sheet open={!!folderSheet} onclose={() => (folderSheet = null)} label={folderSheet?.mode === 'rename' ? 'Rename folder' : 'New folder'}>
	{#if folderSheet}
		<form class="fform" onsubmit={saveFolder}>
			<h2 class="st">{folderSheet.mode === 'rename' ? 'Rename folder' : 'New folder'}</h2>
			<label>Name <input bind:value={folderSheet.name} maxlength={MAX_FOLDER_NAME} required data-testid="folder-name-input" /></label>
			{#if folderSheet.mode === 'create'}
				<label
					>Inside
					<select bind:value={folderSheet.parentId} data-testid="folder-parent">
						<option value={null}>Library (top level)</option>
						{#each topFolders as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
					</select>
				</label>
				<p class="cap muted">Folders nest one level deep. They live in Rotor only and don't change anything in Spotify.</p>
			{/if}
			<div class="acts">
				<button class="btn pri" type="submit" disabled={busy || !folderSheet.name.trim()} data-testid="folder-save">{folderSheet.mode === 'rename' ? 'Save' : folderSheet.moveAfter.length ? `Create and move ${folderSheet.moveAfter.length}` : 'Create'}</button>
				<button class="btn ghost" type="button" onclick={() => (folderSheet = null)}>Cancel</button>
			</div>
		</form>
	{/if}
</Sheet>

<Sheet open={moveOpen} onclose={() => (moveOpen = false)} label="Move to folder">
	<h2 class="st">Move {selEntries.length} to…</h2>
	<p class="cap muted">A playlist is in one folder at a time. Rotor only: nothing moves in Spotify.</p>
	<div role="list" data-testid="move-targets">
		<button class="opt" onclick={() => moveTo(null)} data-testid="move-root"><Icon name="lib" size={18} /> Library (top level)</button>
		{#each targets as t (t.id)}
			{@const blocked = selFolders.length > 0 && (t.depth === 1 || selFolders.some((f) => f.folder.id === t.id || f.children > 0))}
			<button class="opt" class:sub={t.depth === 1} disabled={blocked} onclick={() => moveTo(t.id)} data-testid="move-to" data-folder={t.id}><Icon name="folder" size={18} /> {t.name}</button>
		{/each}
		<button class="opt" disabled={selFolders.length > 0} onclick={() => newFolder(selItems)} data-testid="move-new"><Icon name="plus" size={18} /> New folder…</button>
	</div>
</Sheet>

<Sheet open={confirmDelete} onclose={() => (confirmDelete = false)} label="Delete custom playlists">
	<h2 class="st">Delete {selEntries.length} custom playlist{selEntries.length === 1 ? '' : 's'}?</h2>
	<p class="cap">They're removed from Spotify (through Rotor's write guard: Custom 🎧 playlists only) and from Rotor. This can't be undone.</p>
	<div class="acts">
		<button class="btn danger" onclick={deleteCustom} data-testid="m-delete-confirm">Delete</button>
		<button class="btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
	</div>
</Sheet>

<Sheet open={!!confirmFolder} onclose={() => (confirmFolder = null)} label="Delete folder">
	<h2 class="st">Delete “{confirmFolder?.name}”?</h2>
	<p class="cap">Its playlists and subfolders move back to your Library. No playlist is deleted, and nothing changes in Spotify.</p>
	<div class="acts">
		<button class="btn danger" onclick={removeFolder} data-testid="folder-delete-confirm">Delete folder</button>
		<button class="btn ghost" onclick={() => (confirmFolder = null)}>Cancel</button>
	</div>
</Sheet>

<style>
	.search input {
		width: 100%;
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		padding: 10px 16px;
		font: inherit;
		font-size: 16px;
		margin: 0 0 6px;
	}
	.btn.sm {
		height: 32px;
		padding: 0 12px;
		font-size: 13px;
	}
	.btn.on,
	.ibtn.on {
		color: var(--accent);
	}
	.note {
		font-size: 12px;
		color: var(--text-2);
		background: var(--accent-subtle);
		border-radius: 8px;
		padding: 8px 10px;
		margin: 0 0 8px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 8px;
	}
	.slot {
		position: relative;
	}
	.ghead {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		margin: 8px 0 4px;
	}
	.ghead h2 {
		font-size: 15px;
		font-weight: 800;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.ghead a {
		text-decoration: underline;
	}
	.rest {
		margin-top: 16px;
	}
	.group {
		margin-top: 18px;
	}
	.crumbs {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		color: var(--text-2);
		min-height: 40px;
	}
	.crumbs a {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--text-2);
	}
	.crumbs h2 {
		font-size: 17px;
		font-weight: 800;
		color: var(--text-1);
	}
	.crumbs .grow {
		flex: 1;
	}
	.ibtn.sm {
		width: 36px;
		height: 36px;
	}
	/* Same box as a list row (min-height 64px, 4px 8px padding, 12px gap). */
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
	.managebar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--tabbar-h) + var(--mini-h) + var(--safe-bottom) + 12px);
		z-index: 30;
		display: flex;
		gap: 8px;
		align-items: center;
		overflow-x: auto;
		scrollbar-width: none;
		padding: 10px var(--gutter);
		background: var(--surface-2);
		border-top: 1px solid var(--border);
		box-shadow: var(--shadow-pop);
	}
	.managebar .btn {
		flex: none;
	}
	.cnt {
		flex: none;
		font-size: 13px;
		font-weight: 700;
		margin-right: 4px;
	}
	@media (min-width: 768px) {
		.managebar {
			left: 50%;
			right: auto;
			transform: translateX(-50%);
			width: min(720px, calc(100vw - 48px));
			bottom: 104px;
			border-radius: 12px;
			border: 1px solid var(--border);
		}
	}
	.st {
		font-size: 17px;
		font-weight: 800;
		margin: 0 0 8px;
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 48px;
		padding: 0 8px;
		border-radius: 8px;
		color: var(--text-1);
		text-align: left;
	}
	.opt:hover:not(:disabled) {
		background: var(--surface-3);
	}
	.opt:disabled {
		opacity: 0.45;
	}
	.opt.sub {
		padding-left: 32px;
	}
	.fform {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.fform label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 13px;
		color: var(--text-2);
	}
	.fform input,
	.fform select {
		background: var(--surface-3);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px 12px;
		font: inherit;
		font-size: 16px;
	}
	.acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
</style>
