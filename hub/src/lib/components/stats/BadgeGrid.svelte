<script lang="ts">
	import { fmtDate } from '$lib/shared/format';
	import type { BadgeGridCategory } from '$lib/shared/stats';
	/** Earned bright, unearned dim (views/_badge_display.py). Every slot shown, grouped by category. */
	let { categories }: { categories: BadgeGridCategory[] } = $props();
	const earned = $derived(categories.reduce((a, c) => a + c.chips.filter((x) => x.earned).length, 0));
	const total = $derived(categories.reduce((a, c) => a + c.chips.length, 0));
</script>

<div class="bg">
	<p class="cap muted">{earned} of {total} badges earned</p>
	{#each categories as c (c.name)}
		<div class="cat">
			<h4><span aria-hidden="true">{c.emoji}</span> {c.name}</h4>
			<ul>
				{#each c.chips as b (b.type)}
					<li class:on={b.earned} title={b.earned ? b.details.join('\n') : `${b.label} · not earned yet`}>
						{#if b.icon}<img src={b.icon} alt="" width="40" height="40" loading="lazy" />{:else}<span class="ph" aria-hidden="true">{c.emoji}</span>{/if}
						<span class="lbl">{b.label}{#if b.count > 1} ×{b.count}{/if}</span>
						<span class="sr">{b.earned ? `earned${b.firstAt ? ' ' + fmtDate(b.firstAt) : ''}: ${b.details.join('; ')}` : 'not earned'}</span>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</div>

<style>
	.cat {
		margin-top: 12px;
	}
	h4 {
		font-size: 13px;
		font-weight: 700;
		color: var(--text-2);
		margin: 0 0 6px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	li {
		width: 72px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		text-align: center;
		opacity: 0.32;
		filter: grayscale(1);
	}
	li.on {
		opacity: 1;
		filter: none;
	}
	img,
	.ph {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--surface-3);
		font-size: 20px;
	}
	.lbl {
		font-size: 11px;
		color: var(--text-2);
		line-height: 1.2;
	}
</style>
