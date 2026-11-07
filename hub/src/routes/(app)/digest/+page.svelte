<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import KindBadge from '$lib/components/KindBadge.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { trackHref } from '$lib/shared/stats';
	import { RUN_LABEL, SECTION_TITLE, weekLabel, type DigestPayload, type DigestPlaylist, type DigestSection, type TrackRef } from '$lib/shared/digest';
	import { goto } from '$app/navigation';

	let { data } = $props();
	const d = $derived(data.r.data as DigestPayload | null);
	const SECTIONS: DigestSection[] = ['created', 'updated', 'snapshot'];
	const when = (s: string) => fmtDate(s, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
	const playlistHref = (p: DigestPlaylist) => (p.playlistId ? `/playlist/${encodeURIComponent(p.playlistId)}` : null);
	const DELIVERY: Record<string, string> = { mail_sent: 'mailed', mail_dry_run: 'mail dry-run', mail_failed: 'mail failed' };
</script>

<svelte:head><title>Rotor · This week</title></svelte:head>

{#snippet track(t: TrackRef)}
	{@const href = trackHref(t.uri)}
	<span class="t ell">{#if href}<a {href}>{t.name ?? t.uri}</a>{:else}{t.name ?? t.uri}{/if}</span>
	<span class="a ell">{t.artist ?? ''}</span>
{/snippet}

{#snippet playlist(p: DigestPlaylist)}
	{@const href = playlistHref(p)}
	<article class="pl" data-section={p.section} data-name={p.name}>
		<h3>{#if href}<a {href}>{p.name}</a>{:else}{p.name}{/if} <KindBadge kind={p.kind === 'snapshot' ? 'auto_snapshot' : p.kind === 'custom' ? 'custom' : 'auto_updating'} isOwned /></h3>
		{#if p.description}<p class="cap muted">{p.description}</p>{/if}
		{#if p.isTop && p.ranked.length}
			{#if p.section === 'updated'}<p class="cap muted">+{p.addedCount} tracks now in playlist</p>{/if}
			<ol class="ranked" class:arrows={p.arrows}>
				{#each p.ranked as t (t.uri)}
					<li>
						<span class="r tab-num">{t.rank}</span>
						{#if p.arrows}<span class="ar {t.arrow.dir}" aria-label={t.arrow.dir === 'new' ? 'new' : t.arrow.dir === 'same' ? 'unchanged' : `${t.arrow.dir} ${t.arrow.label.slice(2)}`}>{t.arrow.label}</span>{/if}
						{@render track(t)}
						<span class="p tab-num">{t.plays === null ? '—' : `${fmtInt(t.plays)} plays`}</span>
					</li>
				{/each}
			</ol>
		{:else if p.section === 'created'}
			<p class="cap">{p.addedCount} tracks added at creation.</p>
		{:else}
			<p class="cap muted">+{p.added.length} added, −{p.removed.length} removed</p>
			{#each [['Added', p.added], ['Removed', p.removed]] as const as [label, list] (label)}
				{#if list.length}
					<p class="cap"><b>{label}</b></p>
					<ul class="plain">{#each list as t (t.uri)}<li>{@render track(t)}</li>{/each}</ul>
				{/if}
			{/each}
		{/if}
	</article>
{/snippet}

<div class="view">
	<Header title="This week" />
	{#if !d}
		<StatsError r={data.r} />
	{:else}
		{#if d.lastWeekly}
			<p class="cap" data-testid="digest-last">Last refreshed {when(d.lastWeekly.ranAt)} · {d.lastWeekly.changed} changed</p>
		{/if}
		<nav class="weeknav" aria-label="Weeks">
			<a class="btn sec" href={d.prev ? `/digest?week=${d.prev}` : undefined} aria-disabled={!d.prev} data-testid="digest-older">‹ Older</a>
			<label class="sr" for="wk">Week</label>
			<select id="wk" value={d.week} onchange={(e) => goto(`/digest?week=${(e.currentTarget as HTMLSelectElement).value}`)}>
				{#if !d.weeks.some((w) => w.week === d.week)}<option value={d.week}>{weekLabel(d.week)}</option>{/if}
				{#each d.weeks as w (w.week)}<option value={w.week}>{weekLabel(w.week)}{w.changed !== null ? ` · ${w.changed} changed` : ''}{w.stored ? '' : ' (rebuilt)'}</option>{/each}
			</select>
			<a class="btn sec" href={d.next ? `/digest?week=${d.next}` : undefined} aria-disabled={!d.next} data-testid="digest-newer">Newer ›</a>
		</nav>
		<h2 class="wk" data-testid="digest-week">{weekLabel(d.week)}</h2>

		{#each d.runs as run (run.id)}
			<section class="section run" data-run={run.runType} data-testid="digest-run">
				<div class="sec-h">
					<h2>{RUN_LABEL[run.runType]}</h2>
					<span class="cap muted">{when(run.ranAt)}{run.delivery ? ` · ${DELIVERY[run.delivery] ?? run.delivery.replace('_', ' ')}` : ''}</span>
				</div>
				<p class="sum" data-testid="digest-summary">{run.summary}</p>
				{#each SECTIONS as s (s)}
					{@const list = run.playlists.filter((p) => p.section === s)}
					{#if list.length}
						<h3 class="sh">{SECTION_TITLE[s]}</h3>
						{#each list as p (p.name)}{@render playlist(p)}{/each}
					{/if}
				{/each}
				{#if run.deleted.length}
					<h3 class="sh">Custom playlists deleted</h3>
					<ul class="plain">
						{#each run.deleted as x (x.name)}<li>{x.name} — expired{x.expiresAt ? ` ${x.expiresAt}` : ''}{x.trackCount !== null ? `, ${x.trackCount} tracks` : ''}</li>{/each}
					</ul>
				{/if}
			</section>
		{/each}

		{#if d.reconstructed}
			<section class="section" data-testid="digest-rebuilt">
				<p class="cap muted">
					{d.storing ? 'No digest was stored this week.' : 'Digests are stored from migration 0029 on.'} These are the Top lists rebuilt from their rank history: names and arrows, not the full mail
					(other playlists' added/removed tracks weren't kept before 0029).
				</p>
				{#each d.reconstructed as p (p.playlistId)}{@render playlist(p)}{/each}
			</section>
		{:else if !d.runs.length}
			<p class="cap muted" data-testid="digest-empty">Nothing changed this week{d.storing ? '' : ' (and digests aren’t stored until migration 0029 is applied)'}.</p>
		{/if}
	{/if}
</div>

<style>
	.weeknav {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin: 8px 0 4px;
	}
	.weeknav select {
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--surface-2);
		color: var(--text-1);
		border: 0;
		padding: 0 14px;
		font: inherit;
		font-size: 13px;
		max-width: 100%;
	}
	a[aria-disabled='true'] {
		opacity: 0.4;
		pointer-events: none;
	}
	.wk {
		font-size: 15px;
		margin: 12px 0 0;
	}
	.sum {
		font-weight: 600;
		margin: 0 0 8px;
	}
	.sh {
		font-size: 13px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-3);
		margin: 16px 0 6px;
	}
	.pl {
		margin: 0 0 14px;
	}
	.pl h3 {
		font-size: 15px;
		margin: 0 0 4px;
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.ranked,
	.plain {
		list-style: none;
		padding: 0;
		margin: 4px 0 0;
		display: grid;
		gap: 2px;
		font-size: 13px;
	}
	.ranked li {
		display: grid;
		grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 1fr) auto;
		gap: 8px;
		align-items: baseline;
	}
	.ranked.arrows li {
		grid-template-columns: 28px 44px minmax(0, 1.4fr) minmax(0, 1fr) auto;
	}
	.plain li {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: 8px;
	}
	.r,
	.p,
	.a {
		color: var(--text-3);
	}
	.r {
		text-align: right;
	}
	.ar {
		font-size: 12px;
	}
	.ar.up {
		color: var(--success);
	}
	.ar.down {
		color: var(--danger);
	}
	.ar.new {
		color: var(--warning);
	}
	.ar.same {
		color: var(--text-3);
	}
</style>
