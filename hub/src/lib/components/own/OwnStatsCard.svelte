<script lang="ts">
	import { apiGet } from '$lib/player/api-client';
	import { fmtInt } from '$lib/shared/format';

	/** v0.94: Rotor plays of your own tracks, shown APART from Spotify stats (own_plays, source 'rotor'). */
	interface OwnStats {
		plays: number;
		tracks: number;
		msPlayed: number;
		last30: number;
		top: { id: string; title: string; artist: string; plays: number }[];
		note: string;
	}
	let s = $state<OwnStats | null>(null);
	$effect(() => {
		apiGet<OwnStats>('/api/own/stats')
			.then((r) => (s = r))
			.catch(() => (s = null));
	});
</script>

{#if s && s.plays > 0}
	<section class="section own" aria-labelledby="h-ownplays" data-testid="own-stats">
		<div class="sec-h"><h2 id="h-ownplays">Own tracks · Rotor plays</h2></div>
		<p class="cap muted">{s.note}</p>
		<p><b class="tab-num" data-testid="own-stats-plays">{fmtInt(s.plays)}</b> plays of {s.tracks} own track{s.tracks === 1 ? '' : 's'} · {Math.round(s.msPlayed / 60000)} min · {s.last30} in the last 30 days</p>
		<ol class="top">
			{#each s.top as t (t.id)}<li><a href="/own/{t.id}">{t.title}</a> <span class="cap muted">{t.artist} · {t.plays}</span></li>{/each}
		</ol>
	</section>
{/if}

<style>
	.own {
		border: 1px dashed var(--border);
		border-radius: 12px;
		padding: 12px 14px;
	}
	.top {
		margin: 0;
		padding-left: 20px;
	}
</style>
