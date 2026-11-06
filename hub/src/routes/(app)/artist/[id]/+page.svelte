<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import BadgeGrid from '$lib/components/stats/BadgeGrid.svelte';
	import BarChart from '$lib/components/stats/BarChart.svelte';
	import RankList from '$lib/components/stats/RankList.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt, openInSpotify } from '$lib/shared/format';
	import { fmtScore, trackHref } from '$lib/shared/stats';
	import { shortPeriod } from '$lib/stats-client';
	import { apiDelete, apiGet, apiPut, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';

	let { data } = $props();
	const a = $derived(data.r.data);
	const spotifyUrl = $derived(a ? openInSpotify(`spotify:artist:${a.id}`) : null);

	// R7: "Follow in Rotor" adds the artist to the Release radar (never a Spotify follow).
	// Hidden until the state is known, and when migration 0028 isn't applied (503).
	let followed = $state<boolean | null>(null);
	let followBusy = $state(false);
	$effect(() => {
		const id = a?.id;
		followed = null;
		if (!id) return;
		apiGet<{ followed: boolean }>(`/api/radar/follow/${id}`)
			.then((r) => (followed = r.followed))
			.catch(() => (followed = null));
	});
	async function toggleFollow() {
		if (!a || followed === null) return;
		followBusy = true;
		try {
			const r = followed
				? await apiDelete<{ followed: boolean }>(`/api/radar/follow/${a.id}`)
				: await apiPut<{ followed: boolean }>(`/api/radar/follow/${a.id}`, { name: a.name });
			followed = r.followed;
			toasts.show(r.followed ? `${a.name} is on your Release radar` : `${a.name} is off your Release radar`);
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			followBusy = false;
		}
	}
</script>

<svelte:head><title>Rotor · {a?.name ?? 'Artist'}</title></svelte:head>

<div class="view">
	<Header title="Artist" />
	{#if !a}
		<StatsError r={data.r} />
	{:else}
		<header class="hd">
			<h1 class="ttl">{a.name}</h1>
			<div class="acts">
				{#if spotifyUrl}<a class="btn sec" href={spotifyUrl} target="_blank" rel="noopener">Open Spotify</a>{/if}
				<a class="btn ghost" href="/stats/compare?artistA={encodeURIComponent(a.name)}">Compare with…</a>
				{#if followed !== null}
					<button class="btn {followed ? 'sec' : 'ghost'}" aria-pressed={followed} disabled={followBusy} onclick={toggleFollow}>{followed ? '✓ Following in Rotor' : 'Follow in Rotor'}</button>
				{/if}
			</div>
		</header>
		<div class="tiles">
			<StatTile label="Plays" value={fmtInt(a.metrics.plays)} />
			<StatTile label="Distinct tracks" value={fmtInt(a.metrics.tracks)} />
			<StatTile label="Years in your history" value={fmtInt(a.metrics.yearsActive)} />
			<StatTile label="Last 30 days" value={fmtInt(a.metrics.plays30d)} unit="plays" />
			<StatTile label="First play" value={fmtDate(a.metrics.firstPlayedAt)} small />
			<StatTile label="Last play" value={fmtDate(a.metrics.lastPlayedAt)} small />
			{#if a.scores?.composite !== null && a.scores?.composite !== undefined}<StatTile label="Composite score" value={fmtScore('composite', a.scores.composite)} />{/if}
		</div>
		<section class="section">
			<div class="sec-h"><h2>Timeline</h2></div>
			<BarChart points={a.perMonth} label="Plays per month of {a.name}" xLabel={shortPeriod} height={120} />
		</section>
		<section class="section">
			<div class="sec-h"><h2>Top tracks</h2></div>
			<RankList
				label="Top tracks of {a.name}"
				source="Artist › {a.name}"
				rows={a.topTracks.map((t, i) => ({ key: t.uri, rank: i + 1, title: t.name, href: trackHref(t.uri), value: `${fmtInt(t.plays)} plays`, uri: t.uri }))}
			/>
		</section>
		<section class="section">
			<div class="sec-h"><h2>Badges</h2></div>
			<BadgeGrid categories={a.badges} />
		</section>
	{/if}
</div>

<style>
	.hd {
		margin: 4px 0 16px;
	}
	.ttl {
		font-size: 28px;
		font-weight: 800;
		margin: 0;
	}
	.acts {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 10px;
	}
	.tiles :global(.tile) {
		width: auto;
	}
</style>
