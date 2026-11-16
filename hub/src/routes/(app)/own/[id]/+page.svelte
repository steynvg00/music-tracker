<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Sheet from '$lib/components/Sheet.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import EmbedPlayer from '$lib/components/own/EmbedPlayer.svelte';
	import { apiDelete, apiGet, apiPatch, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { library } from '$lib/stores/library.svelte';
	import { ownPlayer, trackItem } from '$lib/stores/own-player.svelte';
	import { ROLES, ROLE_LABEL, STATUS_LABEL, displayTitle, fmtClock, ownKey, type RotorList } from '$lib/shared/own';
	import { fmtMB } from '$lib/shared/media';
	import { fmtDate } from '$lib/shared/format';

	let { data } = $props();
	const t = $derived(data.r.data);
	let lists = $state<RotorList[]>([]);
	let listId = $state('');
	let confirmDelete = $state(false);
	let busy = $state(false);
	$effect(() => {
		apiGet<{ lists: RotorList[] }>('/api/own/lists')
			.then((r) => (lists = r.lists))
			.catch(() => undefined);
		if (!library.loaded) void library.loadOrg();
	});
	const pinned = $derived(t ? library.org.items.some((i) => i.key === ownKey(t.id) && i.pinPos !== null) : false);

	function play() {
		const it = t ? trackItem(t) : null;
		if (it) void ownPlayer.play([it]);
	}
	async function addToList() {
		if (!t || !listId) return;
		try {
			await apiPatch(`/api/own/lists/${listId}`, { add: [t.id] });
			toasts.show(`Added to ${lists.find((l) => l.id === listId)?.name ?? 'the list'} · Rotor only`);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	async function togglePin() {
		if (!t) return;
		try {
			await library.organise('/api/library/pin', { targets: [ownKey(t.id)], pinned: !pinned });
			toasts.show(pinned ? 'Unpinned' : 'Pinned · in Rotor only');
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	async function remove() {
		if (!t) return;
		busy = true;
		try {
			if (ownPlayer.current?.id === t.id) await ownPlayer.stop();
			const r = await apiDelete<{ files: number }>(`/api/own/${t.id}`);
			toasts.show(`Deleted “${t.title}”${r.files ? ` and its ${r.files === 1 ? 'file' : `${r.files} files`}` : ''}`);
			await goto('/library?source=own');
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			busy = false;
			confirmDelete = false;
		}
	}
</script>

<svelte:head><title>Rotor · {t?.title ?? 'Own track'}</title></svelte:head>

<div class="view">
	<Header title="Own track" />
	{#if !t}
		<StatsError r={data.r} />
	{:else}
		<header class="hd" data-testid="own-detail">
			{#if t.cover}<img class="cover" src={t.cover} alt="" width="160" height="160" referrerpolicy="no-referrer" />{:else}<span class="cover ph"><Icon name="note" size={48} /></span>{/if}
			<div class="info">
				<span class="badge">{STATUS_LABEL[t.status]}</span>
				<h1 class="ttl">{displayTitle(t)}</h1>
				<p class="by">
					{#each t.artists.primary as a, i (a.kind + a.id)}{i ? ', ' : ''}{#if a.kind === 'spotify'}<a href="/artist/{a.id}">{a.name}</a>{:else}<span>{a.name}</span>{/if}{/each}
				</p>
				<p class="cap muted">{fmtClock(t.durationMs)} · {t.plays} Rotor play{t.plays === 1 ? '' : 's'}{t.lastPlayedAt ? ` · last ${fmtDate(t.lastPlayedAt)}` : ''}</p>
				<div class="acts">
					{#if t.audio}<button class="btn pri" onclick={play} data-testid="own-play"><Icon name="play" size={16} /> Play file</button>{/if}
					<a class="btn sec" href="/own/{t.id}/edit">Edit</a>
					{#if !library.orgError}<button class="btn ghost" aria-pressed={pinned} onclick={togglePin}>{pinned ? 'Unpin' : 'Pin'}</button>{/if}
					<button class="btn danger" onclick={() => (confirmDelete = true)} data-testid="own-delete">Delete</button>
				</div>
			</div>
		</header>

		{#if t.youtubeId || t.soundcloudUrl}
			<section class="section"><EmbedPlayer youtubeId={t.youtubeId} soundcloudUrl={t.youtubeId ? null : t.soundcloudUrl} title={t.title} /></section>
		{/if}

		<section class="section">
			<dl class="meta">
				{#each ROLES.slice(1) as role (role)}
					{#if t.artists[role].length}<dt>{ROLE_LABEL[role]}</dt><dd>{t.artists[role].map((a) => a.name).join(', ')}</dd>{/if}
				{/each}
				{#if t.label}<dt>Label</dt><dd>{t.label}</dd>{/if}
				{#if t.date}<dt>{t.dateKind === 'release' ? 'Released' : 'First heard'}</dt><dd>{fmtDate(t.date)}</dd>{/if}
				{#if t.heardSet}<dt>Heard in</dt><dd><a href="/sets/{t.heardSet.id}">{t.heardSet.title}</a>{t.heardAtMs !== null ? ` at ${fmtClock(t.heardAtMs)}` : ''}</dd>{/if}
				{#if t.heardNote}<dt>Where</dt><dd>{t.heardNote}</dd>{/if}
				<dt>Sources</dt>
				<dd>
					{[t.youtubeId ? 'YouTube' : null, t.soundcloudUrl ? 'SoundCloud' : null, t.audio ? `File (${t.audio.name ?? 'upload'}, ${fmtMB(t.audio.size)})` : null].filter(Boolean).join(' · ')}
				</dd>
				{#if t.notes}<dt>Notes</dt><dd class="notes">{t.notes}</dd>{/if}
			</dl>
		</section>

		<section class="section">
			<div class="sec-h"><h2>Add to a Rotor list</h2></div>
			{#if lists.length}
				<div class="addl">
					<select bind:value={listId} aria-label="Rotor list">
						<option value="">Pick a list…</option>
						{#each lists as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
					</select>
					<button class="btn sec" disabled={!listId} onclick={addToList}>Add</button>
				</div>
			{:else}
				<p class="cap muted">No Rotor lists yet: create one in Library › Own & IDs.</p>
			{/if}
			<p class="cap muted">Rotor lists hold own tracks only and never become Spotify playlists.</p>
		</section>
	{/if}
</div>

<Sheet open={confirmDelete} onclose={() => (confirmDelete = false)} label="Delete own track">
	<div class="sheet">
		<h2>Delete “{t?.title}”?</h2>
		<p class="cap">Removes the track, its credits and Rotor plays{t?.audio || t?.coverObjectId ? ', and its uploaded file(s) from storage' : ''}. Tracklist entries that linked it become “ID” entries. This can’t be undone.</p>
		<div class="acts">
			<button class="btn danger" disabled={busy} onclick={remove} data-testid="own-delete-confirm">{busy ? 'Deleting…' : 'Delete'}</button>
			<button class="btn ghost" onclick={() => (confirmDelete = false)}>Cancel</button>
		</div>
	</div>
</Sheet>

<style>
	.hd {
		display: flex;
		gap: 16px;
		align-items: flex-end;
		flex-wrap: wrap;
		margin: 4px 0 16px;
	}
	.cover {
		width: 160px;
		height: 160px;
		border-radius: 8px;
		object-fit: cover;
		background: var(--surface-3);
		display: grid;
		place-items: center;
		color: var(--text-3);
	}
	.info {
		min-width: 0;
		flex: 1;
	}
	.ttl {
		font-size: 26px;
		font-weight: 800;
		margin: 6px 0 2px;
	}
	.by {
		margin: 0 0 4px;
	}
	.acts,
	.addl {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.meta {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 6px 16px;
		margin: 0;
	}
	dt {
		color: var(--text-3);
	}
	dd {
		margin: 0;
		min-width: 0;
	}
	.notes {
		white-space: pre-wrap;
	}
	select {
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		font: inherit;
	}
	.sheet {
		padding: 8px 4px;
	}
</style>
