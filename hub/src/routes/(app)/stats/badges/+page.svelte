<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatsNav from '$lib/components/stats/StatsNav.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import {
		ARTIST_BADGE_CATEGORIES,
		TRACK_BADGE_CATEGORIES,
		artistHref,
		badgeIcon,
		badgeLabel,
		describeBadge,
		trackHref,
		type BadgeEvent
	} from '$lib/shared/stats';

	type BadgesData = { counts: { entityType: 'track' | 'artist'; badgeType: string; count: number; entities: number }[]; recent: BadgeEvent[] };
	let { data } = $props();
	const b = $derived(data.r.data as BadgesData | null);
	const count = (e: 'track' | 'artist', t: string) => b?.counts.find((c) => c.entityType === e && c.badgeType === t);
	const total = $derived(b?.counts.reduce((a, c) => a + c.count, 0) ?? 0);
</script>

<svelte:head><title>Rotor · Badges</title></svelte:head>

<div class="view">
	<Header title="Badges" />
	<StatsNav />
	{#if !b}
		<StatsError r={data.r} />
	{:else}
		<p class="cap muted">{fmtInt(total)} badges awarded. Every badge links to its track or artist.</p>
		<section class="section">
			<div class="sec-h"><h2>Recent</h2></div>
			<ul class="recent">
				{#each b.recent as e (e.entityType + e.entityId + e.badgeType + e.awardedAt)}
					{@const href = e.entityType === 'track' ? trackHref(e.entityId) : artistHref(e.entityId)}
					<li>
						{#if badgeIcon(e.badgeType)}<img src={badgeIcon(e.badgeType)} alt="" width="36" height="36" loading="lazy" />{:else}<span class="ph" aria-hidden="true">★</span>{/if}
						<span class="t">
							<b>{badgeLabel(e.badgeType)}</b> · {#if href}<a {href}>{e.name ?? e.entityId}</a>{:else}{e.name ?? e.entityId}{/if}{#if e.artist} — {e.artist}{/if}
							<span class="cap muted">{describeBadge(e.badgeType, e.context)} · {fmtDate(e.awardedAt)}</span>
						</span>
					</li>
				{:else}
					<li class="muted">No badges yet.</li>
				{/each}
			</ul>
		</section>
		{#each [['Track badges', 'track', TRACK_BADGE_CATEGORIES], ['Artist badges', 'artist', ARTIST_BADGE_CATEGORIES]] as const as [title, kind, cats] (kind)}
			<section class="section">
				<div class="sec-h"><h2>{title}</h2></div>
				{#each cats as c (c.name)}
					<h3><span aria-hidden="true">{c.emoji}</span> {c.name}</h3>
					<ul class="grid">
						{#each c.types as t (t)}
							{@const n = count(kind, t)}
							<li class:on={!!n}>
								{#if badgeIcon(t)}<img src={badgeIcon(t)} alt="" width="40" height="40" loading="lazy" />{:else}<span class="ph" aria-hidden="true">{c.emoji}</span>{/if}
								<span class="lbl">{badgeLabel(t)}</span>
								<span class="cap tab-num">{n ? `${fmtInt(n.entities)} ${kind === 'track' ? 'tracks' : 'artists'}` : 'not yet'}</span>
							</li>
						{/each}
					</ul>
				{/each}
			</section>
		{/each}
	{/if}
</div>

<style>
	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.recent li {
		display: flex;
		gap: 10px;
		align-items: center;
		font-size: 14px;
	}
	.recent .t {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	img,
	.ph {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--surface-3);
		flex: none;
	}
	h3 {
		font-size: 13px;
		color: var(--text-2);
		margin: 12px 0 6px;
	}
	.grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.grid li {
		width: 84px;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 3px;
		opacity: 0.35;
		filter: grayscale(1);
	}
	.grid li.on {
		opacity: 1;
		filter: none;
	}
	.lbl {
		font-size: 12px;
	}
</style>
