<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { apiDelete, apiPatch, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { ownPlayer, trackItem, type OwnItem } from '$lib/stores/own-player.svelte';
	import { artistLine, displayTitle, fmtClock } from '$lib/shared/own';

	/** A Rotor-only list of own tracks (v0.94). Plays in Rotor's own player; never a Spotify playlist. */
	let { data } = $props();
	const l = $derived(data.r.data);
	const playable = $derived((l?.tracks ?? []).map(trackItem).filter((x): x is OwnItem => !!x));

	async function patch(body: Record<string, unknown>, msg: string) {
		if (!l) return;
		try {
			await apiPatch(`/api/own/lists/${l.id}`, body);
			toasts.show(msg);
			await invalidateAll();
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
	function move(i: number, d: -1 | 1) {
		if (!l) return;
		const ids = l.tracks.map((t) => t.id);
		const j = i + d;
		if (j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j]!, ids[i]!];
		void patch({ order: ids }, 'Order saved');
	}
	async function del() {
		if (!l) return;
		try {
			await apiDelete(`/api/own/lists/${l.id}`);
			toasts.show(`Deleted the list “${l.name}” (its tracks stay)`);
			await goto('/library?source=own');
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
</script>

<svelte:head><title>Rotor · {l?.name ?? 'Rotor list'}</title></svelte:head>
<div class="view">
	<Header title="Rotor list" />
	{#if !l}
		<StatsError r={data.r} />
	{:else}
		<h1 class="ttl">{l.name}</h1>
		<p class="cap muted">Rotor list · {l.count} track{l.count === 1 ? '' : 's'} · {fmtClock(l.durationMs)} · own tracks only, never a Spotify playlist</p>
		<div class="acts">
			<button class="btn pri" disabled={!playable.length} onclick={() => ownPlayer.play(playable)} data-testid="list-play"><Icon name="play" size={16} /> Play {playable.length < l.tracks.length ? `${playable.length} with a file` : 'all'}</button>
			<button class="btn danger" onclick={del}>Delete list</button>
		</div>
		<ol class="list">
			{#each l.tracks as t, i (t.id)}
				<li>
					<a href="/own/{t.id}" class="t"><b class="ell">{displayTitle(t)}</b><span class="cap muted ell">{artistLine(t.artists.primary)} · {fmtClock(t.durationMs)}{t.audio ? '' : ' · no file (YouTube/SoundCloud only)'}</span></a>
					<button class="ibtn" aria-label="Move up" disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
					<button class="ibtn" aria-label="Move down" disabled={i === l.tracks.length - 1} onclick={() => move(i, 1)}>↓</button>
					<button class="ibtn" aria-label="Remove {t.title} from this list" onclick={() => patch({ remove: [t.id] }, 'Removed from the list')}><Icon name="close" size={16} /></button>
				</li>
			{/each}
		</ol>
		{#if !l.tracks.length}<p class="muted">Empty. Add tracks from an own track’s page.</p>{/if}
	{/if}
</div>

<style>
	.ttl {
		font-size: 26px;
		font-weight: 800;
		margin: 4px 0;
	}
	.acts {
		display: flex;
		gap: 8px;
		margin: 10px 0;
	}
	.list {
		margin: 0;
		padding: 0 0 0 22px;
	}
	.list li {
		display: flex;
		align-items: center;
		gap: 4px;
		border-bottom: 1px solid var(--border);
		padding: 6px 0;
	}
	.t {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		color: var(--text-1);
	}
</style>
