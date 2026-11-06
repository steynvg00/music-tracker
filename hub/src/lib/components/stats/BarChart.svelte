<script lang="ts">
	import { fmtInt } from '$lib/shared/format';
	import type { SeriesPoint } from '$lib/shared/stats';
	/**
	 * Single-series bar chart (magnitude over time): one hue, thin bars with 4 px rounded tops
	 * anchored to the baseline, a 2 px gap, recessive grid, hover tooltip, and a table view.
	 * No legend: the section title names the series.
	 */
	let {
		points,
		label,
		unit = 'plays',
		height = 160,
		color = 'var(--chart-a)',
		xLabel = (x: string) => x
	}: { points: SeriesPoint[]; label: string; unit?: string; height?: number; color?: string; xLabel?: (x: string) => string } = $props();

	const W = 600;
	const pad = { t: 8, r: 4, b: 20, l: 4 };
	const max = $derived(Math.max(1, ...points.map((p) => p.y)));
	const step = $derived(points.length ? (W - pad.l - pad.r) / points.length : 0);
	const bw = $derived(Math.max(1, step - 2));
	const ih = $derived(height - pad.t - pad.b);
	const ticks = $derived.by(() => {
		if (points.length <= 1) return points.map((_, i) => i);
		const every = Math.max(1, Math.ceil(points.length / 6));
		return points.map((_, i) => i).filter((i) => i % every === 0);
	});
	let hover = $state<number | null>(null);
	const hp = $derived(hover !== null ? points[hover] : null);
</script>

<figure class="chart">
	<figcaption class="sr">{label}</figcaption>
	{#if points.length}
		<div class="wrap" role="img" aria-label="{label}: {points.length} bars, highest {fmtInt(max)} {unit}">
			<svg viewBox="0 0 {W} {height}" preserveAspectRatio="none" width="100%" {height} role="presentation" onpointerleave={() => (hover = null)}>
				{#each [0.25, 0.5, 0.75, 1] as g (g)}
					<line x1={pad.l} x2={W - pad.r} y1={pad.t + ih * (1 - g)} y2={pad.t + ih * (1 - g)} stroke="var(--chart-grid)" stroke-width="1" vector-effect="non-scaling-stroke" />
				{/each}
				{#each points as p, i (p.x)}
					{@const h = (p.y / max) * ih}
					{@const x = pad.l + i * step + 1}
					<!-- 4 px rounded data-end, square at the baseline -->
					<path
						d={h > 0
							? `M${x},${pad.t + ih} V${pad.t + ih - h + Math.min(2, h)} q0,-${Math.min(2, h)} ${Math.min(2, bw / 2)},-${Math.min(2, h)} H${x + bw - Math.min(2, bw / 2)} q${Math.min(2, bw / 2)},0 ${Math.min(2, bw / 2)},${Math.min(2, h)} V${pad.t + ih} Z`
							: ''}
						fill={color}
						opacity={hover === null || hover === i ? 1 : 0.45}
					/>
					<rect x={pad.l + i * step} y={pad.t} width={step} height={ih} fill="transparent" onpointerenter={() => (hover = i)} role="presentation" />
				{/each}
				<line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />
			</svg>
			<div class="xaxis" aria-hidden="true">
				{#each ticks as i (i)}<span style="left:{((i + 0.5) / points.length) * 100}%">{xLabel(points[i]!.x)}</span>{/each}
			</div>
			{#if hp && hover !== null}
				<div class="tip" style="left:{((hover + 0.5) / points.length) * 100}%"><b>{fmtInt(hp.y)}</b> {unit}<br /><span>{xLabel(hp.x)}</span></div>
			{/if}
		</div>
		<details class="tbl">
			<summary>Show as table</summary>
			<table>
				<thead><tr><th scope="col">Period</th><th scope="col">{unit}</th></tr></thead>
				<tbody>{#each points as p (p.x)}<tr><td>{xLabel(p.x)}</td><td class="tab-num">{fmtInt(p.y)}</td></tr>{/each}</tbody>
			</table>
		</details>
	{:else}
		<p class="cap muted">No data yet.</p>
	{/if}
</figure>

<style>
	.chart {
		margin: 0;
	}
	.wrap {
		position: relative;
		padding-bottom: 18px;
	}
	svg {
		display: block;
		overflow: visible;
	}
	.xaxis {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 16px;
	}
	.xaxis span {
		position: absolute;
		transform: translateX(-50%);
		font-size: 11px;
		color: var(--text-3);
		white-space: nowrap;
	}
	.tip {
		position: absolute;
		top: -4px;
		transform: translate(-50%, -100%);
		background: var(--surface-4);
		color: var(--text-1);
		font-size: 12px;
		padding: 6px 8px;
		border-radius: 6px;
		pointer-events: none;
		white-space: nowrap;
		box-shadow: var(--shadow-pop);
		z-index: 2;
	}
	.tip span {
		color: var(--text-2);
	}
	.tbl {
		margin-top: 6px;
		font-size: 13px;
		color: var(--text-2);
	}
	.tbl summary {
		cursor: pointer;
		color: var(--text-3);
		font-size: 12px;
	}
	.tbl table {
		width: 100%;
		max-width: 360px;
		border-collapse: collapse;
		margin-top: 6px;
	}
	.tbl th,
	.tbl td {
		text-align: left;
		padding: 3px 6px;
		border-bottom: 1px solid var(--border);
	}
	.tbl td:last-child,
	.tbl th:last-child {
		text-align: right;
	}
</style>
