<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { apiGet, describeFailure } from '$lib/player/api-client';
	import { library } from '$lib/stores/library.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { artistLine, fmtClock, setKey } from '$lib/shared/own';
	import { SET_SOURCE_LABEL, type DjSetSummary } from '$lib/shared/sets';
	import { fmtDate } from '$lib/shared/format';

	/** DJ / live sets (v0.94): Library › Sets and the Sets page. Pins work like the rest of the Library. */
	let sets = $state<DjSetSummary[] | null>(null);
	let error = $state<string | null>(null);
	let q = $state('');
	$effect(() => {
		apiGet<{ sets: DjSetSummary[] }>('/api/sets')
			.then((r) => (sets = r.sets))
			.catch((e) => {
				error = describeFailure(e);
				sets = [];
			});
		if (!library.loaded) void library.loadOrg();
	});
	const pinOf = (id: string) => library.org.items.find((i) => i.key === setKey(id))?.pinPos ?? null;
	const shown = $derived.by(() => {
		const t = q.trim().toLowerCase();
		const list = (sets ?? []).filter((s) => !t || `${s.title} ${s.event ?? ''} ${artistLine(s.artists)}`.toLowerCase().includes(t));
		return [...list.filter((s) => pinOf(s.id) !== null).sort((a, b) => pinOf(a.id)! - pinOf(b.id)!), ...list.filter((s) => pinOf(s.id) === null)];
	});
	async function togglePin(s: DjSetSummary) {
		const on = pinOf(s.id) === null;
		try {
			await library.organise('/api/library/pin', { targets: [setKey(s.id)], pinned: on });
			toasts.show(on ? `Pinned ${s.title} · in Rotor only` : `Unpinned ${s.title}`);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
</script>

<section aria-label="Sets" data-testid="sets-list">
	<p class="cap muted">DJ and live sets: YouTube and SoundCloud in their own players, uploads in Rotor’s player. Tap a tracklist entry to jump there.</p>
	<div class="bar">
		<a class="btn pri" href="/sets/new" data-testid="set-add"><Icon name="plus" size={16} /> Add set</a>
		<input type="search" bind:value={q} placeholder="Filter sets" aria-label="Filter sets" />
	</div>
	{#if error}<p class="notice" role="alert">{error}</p>{/if}
	{#if sets === null}
		<div class="skel" style="height:64px;border-radius:8px"></div>
	{:else if !shown.length}
		<p class="muted">{q ? 'Nothing matches.' : 'No sets yet.'}</p>
	{:else}
		<ul class="list">
			{#each shown as s (s.id)}
				<li data-testid="set-row">
					<a href="/sets/{s.id}" class="main">
						{#if s.cover}<img src={s.cover} alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" />{:else}<span class="ph"><Icon name="disc" size={22} /></span>{/if}
						<span class="t">
							<b class="ell">{s.title}</b>
							<span class="cap muted ell">{artistLine(s.artists)}{s.event ? ` · ${s.event}` : ''}{s.date ? ` · ${fmtDate(s.date)}` : ''} · {fmtClock(s.durationMs)}{s.entries ? ` · ${s.entries} tracks` : ''}</span>
						</span>
						<span class="badge">{SET_SOURCE_LABEL[s.source]}</span>
					</a>
					{#if !library.orgError}<button class="ibtn" class:on={pinOf(s.id) !== null} aria-pressed={pinOf(s.id) !== null} aria-label="{pinOf(s.id) !== null ? 'Unpin' : 'Pin'} {s.title}" onclick={() => togglePin(s)}><Icon name="pin" size={16} /></button>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.bar {
		display: flex;
		gap: 8px;
		margin: 10px 0;
		align-items: center;
	}
	.bar input {
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
		margin: 0;
		padding: 0;
	}
	.list li {
		display: flex;
		align-items: center;
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
		width: 56px;
		height: 56px;
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
	.ibtn.on {
		color: var(--accent);
	}
</style>
