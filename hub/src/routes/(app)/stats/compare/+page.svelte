<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import LineChart from '$lib/components/stats/LineChart.svelte';
	import StatsBar from '$lib/components/stats/StatsBar.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import type { PeriodSummary } from '$lib/server/stats/sections';
	import { fmtInt } from '$lib/shared/format';
	import { diff } from '$lib/shared/stats';

	type CompareData = {
		mode: 'year' | 'month';
		options: string[];
		a: string | null;
		b: string | null;
		summaryA: PeriodSummary | null;
		summaryB: PeriodSummary | null;
		artists: string[];
		artistA: string | null;
		artistB: string | null;
		battle: { months: string[]; series: { name: string; plays: number; firstMonth: string | null; cumulative: number[] }[] } | null;
	};
	let { data } = $props();
	const c = $derived(data.r.data as CompareData | null);
	function set(k: string, v: string, reset: string[] = []) {
		const u = new URL(page.url);
		u.searchParams.set(k, v);
		for (const r of reset) u.searchParams.delete(r);
		void goto(u.pathname + u.search, { noScroll: true, keepFocus: true });
	}
	const rows = $derived(
		c?.summaryA && c.summaryB
			? ([
					['Plays', c.summaryA.plays, c.summaryB.plays],
					['Unique tracks', c.summaryA.uniqueTracks, c.summaryB.uniqueTracks],
					['Unique artists', c.summaryA.uniqueArtists, c.summaryB.uniqueArtists],
					['Listening days', c.summaryA.days, c.summaryB.days]
				] as const)
			: []
	);
</script>

<svelte:head><title>Rotor · Compare</title></svelte:head>

<div class="view">
	<Header title="Compare" />
	<StatsBar
		groups={c ? [{ key: 'mode', label: 'Compare by', required: true, value: c.mode, options: [{ value: 'year', label: 'Year' }, { value: 'month', label: 'Month' }] }] : []}
		onpick={(_g, v) => v && set('mode', v, ['a', 'b'])}
	/>
	{#if !c}
		<StatsError r={data.r} />
	{:else}
		<section class="section">
			<div class="sec-h"><h2>Period comparison</h2></div>
			<div class="pick">
				<label>A <select value={c.a} onchange={(e) => set('a', e.currentTarget.value)}>{#each c.options as o (o)}<option value={o}>{o}</option>{/each}</select></label>
				<label>B <select value={c.b} onchange={(e) => set('b', e.currentTarget.value)}>{#each c.options as o (o)}<option value={o}>{o}</option>{/each}</select></label>
			</div>
			<table class="cmp">
				<thead><tr><th scope="col"></th><th scope="col">{c.a}</th><th scope="col">{c.b}</th><th scope="col">A − B</th></tr></thead>
				<tbody>
					{#each rows as [label, va, vb] (label)}
						{@const d = diff(va, vb)}
						<tr><th scope="row">{label}</th><td class="tab-num">{fmtInt(va)}</td><td class="tab-num">{fmtInt(vb)}</td><td class="tab-num {d.dir}">{d.text}</td></tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class="section">
			<div class="sec-h"><h2>Artist battle</h2><span class="cap muted">cumulative plays per month</span></div>
			<div class="pick">
				<label>Artist A <select value={c.artistA} onchange={(e) => set('artistA', e.currentTarget.value)}>{#each c.artists as o (o)}<option value={o}>{o}</option>{/each}</select></label>
				<label>Artist B <select value={c.artistB} onchange={(e) => set('artistB', e.currentTarget.value)}>{#each c.artists as o (o)}<option value={o}>{o}</option>{/each}</select></label>
			</div>
			{#if c.battle}
				<LineChart x={c.battle.months} series={c.battle.series.map((s) => ({ name: s.name, values: s.cumulative }))} label="Cumulative plays: {c.artistA} vs {c.artistB}" />
				<p class="cap muted">
					{#each c.battle.series as s, i (s.name)}{i ? ' · ' : ''}{s.name}: {fmtInt(s.plays)} plays since {s.firstMonth ?? '—'}{/each}
				</p>
			{/if}
		</section>
	{/if}
</div>

<style>
	.pick {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		margin-bottom: 12px;
		font-size: 13px;
		color: var(--text-2);
	}
	select {
		background: var(--surface-2);
		color: var(--text-1);
		border: 0;
		border-radius: 8px;
		padding: 7px 10px;
		font: inherit;
		max-width: 220px;
	}
	.cmp {
		width: 100%;
		max-width: 560px;
		border-collapse: collapse;
		font-size: 14px;
	}
	.cmp th,
	.cmp td {
		padding: 8px 6px;
		border-bottom: 1px solid var(--border);
		text-align: right;
	}
	.cmp th[scope='row'] {
		text-align: left;
		color: var(--text-2);
		font-weight: 500;
	}
	.up {
		color: var(--success);
	}
	.down {
		color: var(--warning);
	}
</style>
