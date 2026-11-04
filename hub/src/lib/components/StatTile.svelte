<script lang="ts">
	let {
		label,
		value,
		unit,
		note,
		dir,
		spark,
		sparkColor = 'var(--accent)',
		small = false
	}: { label: string; value: string; unit?: string; note?: string; dir?: 'up' | 'down' | 'flat'; spark?: number[]; sparkColor?: string; small?: boolean } = $props();
	const points = $derived.by(() => {
		if (!spark || spark.length < 2) return '';
		const max = Math.max(...spark, 1);
		return spark.map((v, i) => `${(i / (spark.length - 1)) * 120},${22 - (v / max) * 20}`).join(' ');
	});
</script>

<div class="tile">
	<span class="over">{label}</span>
	<span class="num tab-num" class:small>{value}{#if unit}<small>{unit}</small>{/if}</span>
	{#if note}<span class="note {dir ?? ''}">{note}</span>{/if}
	{#if points}
		<svg class="spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true">
			<polyline {points} fill="none" stroke={sparkColor} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
		</svg>
	{/if}
</div>

<style>
	.tile {
		flex: none;
		width: 148px;
		min-height: 112px;
		padding: 12px;
		border-radius: var(--r-card);
		background: var(--surface-2);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.num {
		font-size: 28px;
		line-height: 32px;
		font-weight: 800;
		letter-spacing: -0.02em;
	}
	.num.small {
		font-size: 18px;
		line-height: 22px;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.num small {
		font-size: 14px;
		font-weight: 700;
		color: var(--text-2);
		margin-left: 2px;
	}
	.note {
		font-size: 12px;
		font-weight: 800;
		color: var(--text-2);
	}
	.note.up {
		color: var(--success);
	}
	.note.down {
		color: var(--danger);
	}
	.spark {
		width: 100%;
		height: 24px;
		margin-top: auto;
	}
	@media (min-width: 768px) {
		.tile {
			width: auto;
		}
		.num {
			font-size: 32px;
			line-height: 36px;
		}
	}
</style>
