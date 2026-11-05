<script lang="ts">
	import { fmtInt } from '$lib/shared/format';
	/**
	 * Up to two series over shared x labels (artist battle: cumulative plays). 2 px lines, fixed
	 * colour order (--chart-a, --chart-b), a legend plus direct end labels, a crosshair tooltip and a
	 * table view. One y-axis only.
	 */
	let { x, series, label }: { x: string[]; series: { name: string; values: number[] }[]; label: string } = $props();
	const COLORS = ['var(--chart-a)', 'var(--chart-b)'];
	const W = 600;
	const H = 180;
	const pad = { t: 10, r: 8, b: 20, l: 8 };
	const max = $derived(Math.max(1, ...series.flatMap((s) => s.values)));
	const px = (i: number) => pad.l + (x.length <= 1 ? 0 : (i / (x.length - 1)) * (W - pad.l - pad.r));
	const py = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
	let hover = $state<number | null>(null);
	function move(e: PointerEvent) {
		const svg = e.currentTarget as SVGSVGElement;
		const r = svg.getBoundingClientRect();
		const rel = (e.clientX - r.left) / r.width;
		hover = Math.max(0, Math.min(x.length - 1, Math.round(rel * (x.length - 1))));
	}
</script>

<figure class="lc">
	<figcaption class="sr">{label}</figcaption>
	<div class="legend">
		{#each series.slice(0, 2) as s, i (s.name)}<span><i style="background:{COLORS[i]}"></i>{s.name}</span>{/each}
	</div>
	{#if x.length}
		<div class="wrap">
			<svg viewBox="0 0 {W} {H}" width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={label} onpointermove={move} onpointerleave={() => (hover = null)}>
				{#each [0.5, 1] as g (g)}<line x1={pad.l} x2={W - pad.r} y1={py(max * g)} y2={py(max * g)} stroke="var(--chart-grid)" vector-effect="non-scaling-stroke" />{/each}
				{#each series.slice(0, 2) as s, i (s.name)}
					<polyline points={s.values.map((v, j) => `${px(j)},${py(v)}`).join(' ')} fill="none" stroke={COLORS[i]} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
				{/each}
				{#if hover !== null}<line x1={px(hover)} x2={px(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--text-3)" vector-effect="non-scaling-stroke" />{/if}
			</svg>
			<div class="ends" aria-hidden="true">
				{#each series.slice(0, 2) as s, i (s.name)}<span style="top:{(py(s.values.at(-1) ?? 0) / H) * 100}%;color:var(--text-2)"><i style="background:{COLORS[i]}"></i>{fmtInt(s.values.at(-1) ?? 0)}</span>{/each}
			</div>
			{#if hover !== null}
				<div class="tip" style="left:{(px(hover) / W) * 100}%">
					<b>{x[hover]}</b>{#each series.slice(0, 2) as s, i (s.name)}<br /><i style="background:{COLORS[i]}"></i>{s.name}: {fmtInt(s.values[hover] ?? 0)}{/each}
				</div>
			{/if}
		</div>
		<details class="tbl">
			<summary>Show as table</summary>
			<table>
				<thead><tr><th scope="col">Month</th>{#each series as s (s.name)}<th scope="col">{s.name}</th>{/each}</tr></thead>
				<tbody>{#each x as m, j (m)}<tr><td>{m}</td>{#each series as s (s.name)}<td class="tab-num">{fmtInt(s.values[j] ?? 0)}</td>{/each}</tr>{/each}</tbody>
			</table>
		</details>
	{/if}
</figure>

<style>
	.lc {
		margin: 0;
	}
	.legend {
		display: flex;
		gap: 14px;
		font-size: 12px;
		color: var(--text-2);
		margin-bottom: 6px;
	}
	i {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		margin-right: 6px;
		vertical-align: -1px;
	}
	.wrap {
		position: relative;
		padding-right: 52px;
	}
	svg {
		display: block;
	}
	.ends span {
		position: absolute;
		right: 0;
		transform: translateY(-50%);
		font-size: 11px;
	}
	.tip {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		background: var(--surface-4);
		font-size: 12px;
		padding: 6px 8px;
		border-radius: 6px;
		pointer-events: none;
		white-space: nowrap;
		box-shadow: var(--shadow-pop);
	}
	.tbl summary {
		cursor: pointer;
		color: var(--text-3);
		font-size: 12px;
	}
	table {
		border-collapse: collapse;
		font-size: 12px;
		color: var(--text-2);
	}
	td,
	th {
		padding: 2px 8px;
		text-align: left;
	}
</style>
