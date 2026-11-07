<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { SOURCE_LABEL, parseLink, type Collection, type Source } from '$lib/shared/elsewhere';
	import { fmtDate } from '$lib/shared/format';
	import { collectionKey, reorder } from '$lib/shared/library';
	import { library } from '$lib/stores/library.svelte';
	import { sortable } from '$lib/actions/sortable';

	/**
	 * One Elsewhere source (YouTube or SoundCloud): paste-a-link import + the imported collections.
	 * Never shown next to Spotify content (03-ux-ia.md §3): the Library source switch is exclusive.
	 */
	let { source }: { source: Source } = $props();
	let rows = $state<Collection[] | null>(null);
	let ytKey = $state(true);
	let link = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function load() {
		try {
			const r = await apiGet<{ collections: Collection[]; youtubeKey: boolean }>(`/api/collections?source=${source}`);
			rows = Array.isArray(r?.collections) ? r.collections : [];
			ytKey = !!r?.youtubeKey;
		} catch (e) {
			error = describeFailure(e);
			rows = [];
		}
	}
	$effect(() => {
		void source;
		rows = null;
		void load();
		if (!library.loaded) void library.loadOrg(); // /elsewhere doesn't load the Library
	});

	// v0.91: pins (Rotor only). Pinned collections stay in THIS source's list, on top: never next to Spotify.
	const pinOf = (id: string) => library.org.items.find((i) => i.key === collectionKey(id))?.pinPos ?? null;
	const pinned = $derived((rows ?? []).filter((c) => pinOf(c.id) !== null).sort((a, b) => pinOf(a.id)! - pinOf(b.id)!));
	const unpinned = $derived((rows ?? []).filter((c) => pinOf(c.id) === null));
	async function togglePin(c: Collection) {
		const on = pinOf(c.id) === null;
		try {
			await library.organise('/api/library/pin', { targets: [collectionKey(c.id)], pinned: on });
			toasts.show(on ? `Pinned ${c.title} · in Rotor only` : `Unpinned ${c.title}`);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	async function reorderPinned(from: number, to: number) {
		const keys = reorder(
			pinned.map((c) => collectionKey(c.id)),
			from,
			to
		);
		try {
			await library.organise('/api/library/pins', { targets: keys }, 'PUT');
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const p = parseLink(link);
		if ('error' in p) return void (error = p.error);
		if (p.source !== source) return void (error = `That's a ${SOURCE_LABEL[p.source]} link: switch to ${SOURCE_LABEL[p.source]} first`);
		busy = true;
		error = null;
		try {
			const r = await apiPost<{ collection: Collection; units: number; items: number; notEmbeddable: number }>('/api/collections', { url: link });
			toasts.show(
				`Imported ${r.collection.title} · ${r.items} item${r.items === 1 ? '' : 's'}${r.notEmbeddable ? ` (${r.notEmbeddable} can’t play here)` : ''}${source === 'youtube' ? ` · ${r.units} quota units` : ''}`
			);
			link = '';
			await goto(`/elsewhere/${r.collection.id}`);
		} catch (err) {
			error = describeFailure(err);
		} finally {
			busy = false;
		}
	}
</script>

<section class="els" aria-label="{SOURCE_LABEL[source]} collections">
	<p class="cap muted">
		{source === 'youtube'
			? 'Public or unlisted YouTube playlists (or single videos). Plays in YouTube’s own player, inside Rotor, while the page is open.'
			: 'SoundCloud sets and tracks (public or secret links). Plays in SoundCloud’s own widget, inside Rotor.'}
		Kept apart from Spotify.
	</p>
	{#if source === 'youtube' && !ytKey}
		<p class="notice">YouTube import isn't set up yet: add the YouTube Data API key to the hub's server environment (Settings › Elsewhere).</p>
	{/if}
	<form class="imp" onsubmit={submit}>
		<label class="sr" for="imp-{source}">{SOURCE_LABEL[source]} link</label>
		<input id="imp-{source}" bind:value={link} placeholder={source === 'youtube' ? 'https://www.youtube.com/playlist?list=…' : 'https://soundcloud.com/…/sets/…'} inputmode="url" autocomplete="off" />
		<button class="btn pri" type="submit" disabled={busy || !link.trim() || (source === 'youtube' && !ytKey)}>{busy ? 'Importing…' : 'Import'}</button>
	</form>
	{#if error}<p class="notice" role="alert">{error}</p>{/if}

	{#if rows === null}
		<div class="skel" style="height:64px;margin-top:12px;border-radius:8px"></div>
	{:else if !rows.length}
		<p class="muted empty">No {SOURCE_LABEL[source]} collections yet. Paste a link above.</p>
	{:else}
		{#snippet item(c: Collection, i: number, isPinned: boolean)}
			<li data-sort-index={i} data-testid="collection" data-id={c.id}>
				<a href="/elsewhere/{c.id}">
					{#if c.artworkUrl}<img src={c.artworkUrl} alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" />{:else}<span class="ph"><Icon name="note" size={22} /></span>{/if}
					<span class="t">
						<b class="ell">{c.title}</b>
						<span class="cap muted ell">{c.owner ?? ''}{c.owner ? ' · ' : ''}{c.itemCount} item{c.itemCount === 1 ? '' : 's'} · checked {fmtDate(c.lastSyncedAt)}</span>
					</span>
					<span class="src {c.source}">{SOURCE_LABEL[c.source]}</span>
				</a>
				{#if !library.orgError}
					<button class="pinbtn" class:on={isPinned} aria-pressed={isPinned} aria-label="{isPinned ? 'Unpin' : 'Pin'} {c.title}" title={isPinned ? 'Unpin (Rotor only)' : 'Pin to the top (Rotor only)'} onclick={() => togglePin(c)}><Icon name="pin" size={16} /></button>
				{/if}
				{#if isPinned && pinned.length > 1}<button class="pinbtn" data-sort-handle aria-label="Reorder {c.title} (drag, or arrow keys)"><Icon name="drag" size={16} /></button>{/if}
			</li>
		{/snippet}
		{#if pinned.length}
			<p class="cap muted pinh"><Icon name="pin" size={12} /> Pinned · in Rotor only</p>
			<ul class="list" data-testid="pinned-collections" use:sortable={{ onreorder: reorderPinned }}>
				{#each pinned as c, i (c.id)}{@render item(c, i, true)}{/each}
			</ul>
		{/if}
		<ul class="list">
			{#each unpinned as c, i (c.id)}{@render item(c, i, false)}{/each}
		</ul>
	{/if}
</section>

<style>
	.imp {
		display: flex;
		gap: 8px;
		margin: 10px 0;
	}
	.imp input {
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
		margin: 8px 0 0;
		padding: 0;
	}
	.list a {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
		color: var(--text-1);
		border-bottom: 1px solid var(--border);
		min-height: 64px;
	}
	.list img,
	.ph {
		width: 56px;
		height: 56px;
		border-radius: var(--r-art-s);
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
	.empty {
		padding: 16px 0;
	}
	.list li {
		display: flex;
		align-items: center;
		touch-action: pan-y;
	}
	.list li > a {
		flex: 1;
		min-width: 0;
	}
	.pinbtn {
		flex: none;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		color: var(--text-3);
	}
	.pinbtn.on {
		color: var(--accent);
	}
	.pinh {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 12px 0 0;
	}
</style>
