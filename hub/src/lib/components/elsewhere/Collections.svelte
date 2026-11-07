<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { SOURCE_LABEL, parseLink, type Collection, type Source } from '$lib/shared/elsewhere';
	import { fmtDate } from '$lib/shared/format';

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
	});

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
		<ul class="list">
			{#each rows as c (c.id)}
				<li>
					<a href="/elsewhere/{c.id}">
						{#if c.artworkUrl}<img src={c.artworkUrl} alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" />{:else}<span class="ph"><Icon name="note" size={22} /></span>{/if}
						<span class="t">
							<b class="ell">{c.title}</b>
							<span class="cap muted ell">{c.owner ?? ''}{c.owner ? ' · ' : ''}{c.itemCount} item{c.itemCount === 1 ? '' : 's'} · checked {fmtDate(c.lastSyncedAt)}</span>
						</span>
						<span class="src {c.source}">{SOURCE_LABEL[c.source]}</span>
					</a>
				</li>
			{/each}
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
</style>
