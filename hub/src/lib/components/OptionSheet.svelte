<script lang="ts" module>
	export interface OptionSection {
		key: string;
		title: string;
		options: { value: string; label: string; href?: string }[];
		value: string | null;
		onselect: (value: string) => void;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Sheet from './Sheet.svelte';

	/** A bottom sheet with one or more single-choice lists (sort, view, section, year, metric). */
	let { open, onclose, title, sections, children }: { open: boolean; onclose: () => void; title: string; sections: OptionSection[]; children?: Snippet } = $props();
</script>

<Sheet {open} {onclose} label={title}>
	<h2 class="t">{title}</h2>
	{#each sections as s (s.key)}
		<div class="sec" role="radiogroup" aria-label={s.title} data-testid="sheet-{s.key}">
			{#if sections.length > 1 || s.title !== title}<h3>{s.title}</h3>{/if}
			{#each s.options as o (o.value)}
				{#if o.href}
					<a class="opt" class:on={s.value === o.value} role="radio" aria-checked={s.value === o.value} href={o.href} onclick={onclose}>{o.label}</a>
				{:else}
					<button class="opt" class:on={s.value === o.value} role="radio" aria-checked={s.value === o.value} onclick={() => (s.onselect(o.value), onclose())}>{o.label}</button>
				{/if}
			{/each}
		</div>
	{/each}
	{#if children}{@render children()}{/if}
</Sheet>

<style>
	.t {
		font-size: 17px;
		font-weight: 800;
		margin: 0 0 8px;
	}
	h3 {
		font-size: 12px;
		font-weight: 800;
		color: var(--text-3);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		margin: 12px 0 4px;
	}
	.opt {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 44px;
		padding: 0 8px;
		border-radius: 8px;
		color: var(--text-1);
		text-align: left;
		font-size: 15px;
	}
	.opt.on {
		color: var(--accent);
		font-weight: 700;
	}
	.opt.on::after {
		content: '✓';
		margin-left: auto;
	}
	.opt:hover {
		background: var(--surface-3);
	}
</style>
