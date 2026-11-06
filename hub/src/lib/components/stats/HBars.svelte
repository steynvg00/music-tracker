<script lang="ts">
	import { fmtInt } from '$lib/shared/format';
	/**
	 * Labelled horizontal bars for shares (platforms, end reasons, weekend vs weekday). Each row
	 * carries its label and value as text; the bar is one hue, so nothing is colour-only.
	 */
	let { rows, label, suffix = '' }: { rows: { label: string; value: number; note?: string; href?: string | null }[]; label: string; suffix?: string } = $props();
	const max = $derived(Math.max(1, ...rows.map((r) => r.value)));
</script>

<ul class="hb" aria-label={label}>
	{#each rows as r (r.label)}
		<li>
			<span class="l ell">{#if r.href}<a href={r.href}>{r.label}</a>{:else}{r.label}{/if}</span>
			<span class="bar"><i style="width:{Math.max(1, (r.value / max) * 100)}%"></i></span>
			<span class="v tab-num">{fmtInt(r.value)}{suffix}{#if r.note}<small> {r.note}</small>{/if}</span>
		</li>
	{/each}
</ul>

<style>
	.hb {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	li {
		display: grid;
		grid-template-columns: minmax(90px, 34%) 1fr auto;
		gap: 10px;
		align-items: center;
		font-size: 13px;
	}
	.l a {
		color: var(--text-1);
	}
	.bar {
		height: 10px;
		background: var(--surface-3);
		border-radius: 0 4px 4px 0;
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		background: var(--chart-a);
		border-radius: 0 4px 4px 0;
	}
	.v {
		color: var(--text-2);
		min-width: 56px;
		text-align: right;
	}
	.v small {
		color: var(--text-3);
	}
</style>
