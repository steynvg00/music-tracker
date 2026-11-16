<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { apiGet } from '$lib/player/api-client';
	import { STATUS_LABEL, artistLine, displayTitle, fmtClock, type OwnTrack } from '$lib/shared/own';
	import type { DjSetSummary } from '$lib/shared/sets';

	/**
	 * v0.94: own tracks + sets for an artist page ("Unreleased & IDs") or a search. Fetched apart from the
	 * stats APIs, so Spotify stats and their caches never mix with Rotor data.
	 */
	let { artist = null, q = null, title }: { artist?: string | null; q?: string | null; title: string } = $props();
	let tracks = $state<OwnTrack[]>([]);
	let sets = $state<DjSetSummary[]>([]);
	$effect(() => {
		const param = artist ? `artist=${encodeURIComponent(artist)}` : q && q.trim().length >= 2 ? `q=${encodeURIComponent(q.trim())}` : null;
		if (!param) {
			tracks = [];
			sets = [];
			return;
		}
		let live = true;
		void Promise.allSettled([apiGet<{ tracks: OwnTrack[] }>(`/api/own?${param}`), apiGet<{ sets: DjSetSummary[] }>(`/api/sets?${param}`)]).then(([t, s]) => {
			if (!live) return;
			tracks = t.status === 'fulfilled' ? t.value.tracks : [];
			sets = s.status === 'fulfilled' ? s.value.sets : [];
		});
		return () => (live = false);
	});
</script>

{#if tracks.length || sets.length}
	<section class="section" data-testid="own-results">
		<div class="sec-h"><h2>{title}</h2></div>
		<ul class="rows">
			{#each tracks as t (t.id)}
				<li>
					<a href="/own/{t.id}" class="r">
						<Icon name="note" size={18} />
						<span class="t"><b class="ell">{displayTitle(t)}</b><span class="cap muted ell">{artistLine(t.artists.primary)} · {fmtClock(t.durationMs)}</span></span>
						<span class="badge">{STATUS_LABEL[t.status]}</span>
					</a>
				</li>
			{/each}
			{#each sets as s (s.id)}
				<li>
					<a href="/sets/{s.id}" class="r">
						<Icon name="disc" size={18} />
						<span class="t"><b class="ell">{s.title}</b><span class="cap muted ell">{artistLine(s.artists)}{s.event ? ` · ${s.event}` : ''} · {fmtClock(s.durationMs)}</span></span>
						<span class="badge">Set</span>
					</a>
				</li>
			{/each}
		</ul>
		<p class="cap muted">In Rotor only, apart from your Spotify history.</p>
	</section>
{/if}

<style>
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.r {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		color: var(--text-1);
	}
	.t {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
</style>
