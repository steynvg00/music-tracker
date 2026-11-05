<script lang="ts">
	import { fmtInt } from '$lib/shared/format';
	import { WEEKDAYS_MON } from '$lib/shared/stats';
	/** "When you listen": 7 × 24 cells, one sequential hue (accent, light → strong). Hover = exact count. */
	let { grid, label = 'Plays by weekday and hour' }: { grid: number[][]; label?: string } = $props();
	const max = $derived(Math.max(1, ...grid.flat()));
	let hover = $state<{ d: number; h: number } | null>(null);
	const total = $derived(grid.flat().reduce((a, b) => a + b, 0));
</script>

<figure class="hm">
	<figcaption class="sr">{label}</figcaption>
	<div class="grid" role="img" aria-label="{label}, {fmtInt(total)} plays in total">
		<span></span>
		{#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<span class="hh">{h % 3 === 0 ? h : ''}</span>{/each}
		{#each grid as row, d (d)}
			<span class="dd">{WEEKDAYS_MON[d]}</span>
			{#each row as v, h (h)}
				<span
					class="cell"
					role="presentation"
					style="--a:{v === 0 ? 0.06 : 0.15 + 0.85 * (v / max)}"
					onpointerenter={() => (hover = { d, h })}
					onpointerleave={() => (hover = null)}
					title="{WEEKDAYS_MON[d]} {String(h).padStart(2, '0')}:00 · {fmtInt(v)} plays"
				></span>
			{/each}
		{/each}
	</div>
	<p class="cap muted read" aria-live="polite">
		{#if hover}{WEEKDAYS_MON[hover.d]} {String(hover.h).padStart(2, '0')}:00–{String(hover.h + 1).padStart(2, '0')}:00 · {fmtInt(grid[hover.d]![hover.h]!)} plays{:else}Darker = more plays. Hover a cell for the count.{/if}
	</p>
	<details class="tbl">
		<summary>Show as table</summary>
		<div class="scroll">
			<table>
				<thead><tr><th scope="col">Day</th>{#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<th scope="col">{h}</th>{/each}</tr></thead>
				<tbody>{#each grid as row, d (d)}<tr><th scope="row">{WEEKDAYS_MON[d]}</th>{#each row as v, h (h)}<td>{v}</td>{/each}</tr>{/each}</tbody>
			</table>
		</div>
	</details>
</figure>

<style>
	.hm {
		margin: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: 34px repeat(24, 1fr);
		gap: 2px;
		align-items: center;
	}
	.hh,
	.dd {
		font-size: 10px;
		color: var(--text-3);
	}
	.hh {
		text-align: left;
	}
	.cell {
		aspect-ratio: 1;
		border-radius: 3px;
		background: color-mix(in srgb, var(--chart-a) calc(var(--a) * 100%), var(--surface-2));
	}
	.read {
		margin-top: 6px;
		min-height: 18px;
	}
	.tbl summary {
		cursor: pointer;
		color: var(--text-3);
		font-size: 12px;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		font-size: 11px;
		color: var(--text-2);
	}
	th,
	td {
		padding: 2px 4px;
		text-align: right;
	}
</style>
