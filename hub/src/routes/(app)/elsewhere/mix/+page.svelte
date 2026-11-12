<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import { apiGet, apiPost, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { mixesEnabled } from '$lib/conductor/opt-in';
	import { fmtDate } from '$lib/shared/format';

	/** Mixes (R5, experimental): a separate list type in Elsewhere. Off unless opted in on this device. */
	let enabled = $state(false);
	let mixes = $state<{ id: string; name: string; itemCount: number; updatedAt: string }[] | null>(null);
	let name = $state('');
	onMount(async () => {
		enabled = mixesEnabled();
		if (enabled) mixes = (await apiGet<{ mixes: typeof mixes }>('/api/mixes').catch(() => ({ mixes: [] }))).mixes ?? [];
	});
	async function create(e: SubmitEvent) {
		e.preventDefault();
		try {
			const r = await apiPost<{ id: string }>('/api/mixes', { name });
			await goto(`/elsewhere/mix/${r.id}`);
		} catch (err) {
			toasts.error(describeFailure(err));
		}
	}
</script>

<svelte:head><title>Rotor · Mixes</title></svelte:head>

<div class="view">
	<Header title="Mixes" />
	{#if !enabled}
		<p class="notice">Mixed sessions are off on this device. They’re an experiment that conflicts with Spotify’s developer policy; turn them on in <a href="/settings#experimental">Settings › Experimental</a>.</p>
	{:else}
		<p class="cap muted">Experimental. A mix plays Spotify and YouTube/SoundCloud items one after another, never at the same time. Best on the laptop with Spotify on “This laptop”.</p>
		<form class="new" onsubmit={create}>
			<label class="sr" for="mixname">Mix name</label>
			<input id="mixname" bind:value={name} placeholder="New mix name" maxlength="100" />
			<button class="btn pri" type="submit" disabled={!name.trim()}>Create mix</button>
		</form>
		<ul class="list">
			{#each mixes ?? [] as m (m.id)}
				<li><a href="/elsewhere/mix/{m.id}"><b>{m.name}</b><span class="cap muted">{m.itemCount} items · {fmtDate(m.updatedAt)}</span></a></li>
			{:else}
				{#if mixes}<li class="muted">No mixes yet.</li>{/if}
			{/each}
		</ul>
	{/if}
</div>

<style>
	.new {
		display: flex;
		gap: 8px;
		margin: 12px 0;
	}
	.new input {
		flex: 1;
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
	.list a {
		display: flex;
		flex-direction: column;
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
		color: var(--text-1);
	}
</style>
