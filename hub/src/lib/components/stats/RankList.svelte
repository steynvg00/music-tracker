<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { apiPost, describeFailure } from '$lib/player/api-client';
	import { player } from '$lib/stores/player.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { MAX_NAME, type Lifetime } from '$lib/shared/custom';
	import type { RankRow } from '$lib/shared/stats';


	/**
	 * Ranked rows for Stats lists. Tap a title = open its detail (browsing data, 03-ux-ia §2.3);
	 * the small ▶ plays that one track. The header plays the whole list or saves it as a
	 * Custom 🎧 playlist (POST /api/custom/from-tracks, guarded server-side).
	 */
	let { rows, label, source, playable = true }: { rows: RankRow[]; label: string; source: string; playable?: boolean } = $props();
	const uris = $derived(rows.map((r) => r.uri).filter((u): u is string => !!u && /^spotify:track:[A-Za-z0-9]{22}$/.test(u)));
	let saving = $state(false);
	let showSave = $state(false);
	let name = $state('');
	let lifetime = $state<Lifetime>('7d');

	function playAll() {
		void player.play({ type: 'play', body: { uris: uris.slice(0, 100) }, label });
	}
	function playOne(uri: string, title: string) {
		void player.play({ type: 'play', body: { uris: [uri] }, label: title });
	}
	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (saving) return;
		saving = true;
		try {
			const r = await apiPost<{ playlistId: string; name: string; trackCount: number }>('/api/custom/from-tracks', { name, uris, lifetime, source });
			toasts.show(`Created ${r.name} · ${r.trackCount} tracks`);
			showSave = false;
			await goto(`/playlist/${r.playlistId}`);
		} catch (err) {
			toasts.error(describeFailure(err));
		} finally {
			saving = false;
		}
	}
</script>

<div class="rl">
	{#if playable && uris.length}
		<div class="acts">
			<button class="btn pri" onclick={playAll}><Icon name="play" size={16} /> Play {Math.min(uris.length, 100)}</button>
			<button class="btn sec" onclick={() => ((showSave = !showSave), (name ||= label.slice(0, MAX_NAME)))} aria-expanded={showSave}>Save as custom playlist</button>
		</div>
		{#if showSave}
			<form class="save" onsubmit={save}>
				<label>Name <input bind:value={name} maxlength={MAX_NAME} required /><span class="cap muted">· Custom 🎧</span></label>
				<label>Keep for
					<select bind:value={lifetime}><option value="7d">7 days</option><option value="30d">30 days</option><option value="keep">Keep</option></select>
				</label>
				<button class="btn pri" type="submit" disabled={saving || !name.trim()}>{saving ? 'Creating…' : `Create · ${uris.length} tracks`}</button>
			</form>
		{/if}
	{/if}
	<ol aria-label={label}>
		{#each rows as r, i (r.key)}
			<li>
				<span class="n tab-num">{r.rank ?? i + 1}</span>
				<span class="t">
					{#if r.href}<a class="ell" href={r.href}>{r.title}</a>{:else}<span class="ell">{r.title}</span>{/if}
					{#if r.subtitle}{#if r.subHref}<a class="s ell" href={r.subHref}>{r.subtitle}</a>{:else}<span class="s ell">{r.subtitle}</span>{/if}{/if}
				</span>
				<span class="v tab-num">{r.value}</span>
				{#if playable && r.uri}
					<button class="ibtn" aria-label="Play {r.title}" onclick={() => playOne(r.uri!, r.title)}><Icon name="play" size={16} /></button>
				{/if}
			</li>
		{:else}
			<li class="empty muted">Nothing here yet.</li>
		{/each}
	</ol>
</div>

<style>
	.acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 10px;
	}
	.save {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: end;
		background: var(--surface-2);
		border-radius: var(--r-card);
		padding: 12px;
		margin-bottom: 12px;
	}
	.save label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--text-2);
	}
	.save input,
	.save select {
		background: var(--surface-3);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		font: inherit;
		min-width: 180px;
	}
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: grid;
		grid-template-columns: 28px 1fr auto 36px;
		align-items: center;
		gap: 10px;
		padding: 7px 0;
		border-bottom: 1px solid var(--border);
		min-height: 48px;
	}
	.n {
		color: var(--text-3);
		font-size: 13px;
		text-align: right;
	}
	.t {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.t a,
	.t > span {
		color: var(--text-1);
		font-size: 14px;
		font-weight: 600;
	}
	.t .s {
		color: var(--text-2);
		font-weight: 400;
		font-size: 12px;
	}
	.v {
		color: var(--text-2);
		font-size: 13px;
	}
	.empty {
		display: block;
		border: 0;
	}
</style>
