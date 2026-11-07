<script lang="ts" module>
	export interface PillMenu {
		key: string;
		label: string;
		/** Shown highlighted (a non-default choice). */
		active?: boolean;
		/** After the selectable pills (page filters), instead of before them (the Stats section). */
		after?: boolean;
		onclick: () => void;
	}
</script>

<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import { hasClearable, pick, visiblePills, type PillGroup } from '$lib/shared/pills';

	/**
	 * The one filter bar (v0.91) for Library and Stats: × (clear) · menu pills (▾, open a sheet) ·
	 * selectable pills · a small icon button at the end (sort & view / metric). One row, scrolls
	 * sideways, fixed height (no layout shift while it fills in).
	 */
	let {
		label,
		groups = [],
		menus = [],
		onpick,
		onclear,
		action,
		ready = true,
		testid = 'pillbar'
	}: {
		label: string;
		groups?: PillGroup[];
		menus?: PillMenu[];
		onpick?: (group: string, value: string | null) => void;
		onclear?: () => void;
		action?: { label: string; icon: IconName; onclick: () => void; active?: boolean };
		/** false until client-only state (saved filters) is known: the bar keeps its height, empty. */
		ready?: boolean;
		testid?: string;
	} = $props();

	const pills = $derived(visiblePills(groups));
	const clearable = $derived(!!onclear && hasClearable(groups));
	const byKey = $derived(new Map(groups.map((g) => [g.key, g])));
</script>

{#snippet menu(m: PillMenu)}
	<button class="pill menu" class:on={m.active} aria-haspopup="dialog" onclick={m.onclick} data-testid="pill-menu-{m.key}">{m.label} <Icon name="down" size={14} /></button>
{/snippet}

<div class="pillbar" role="toolbar" aria-label={label} data-testid={testid}>
	<div class="scroll">
		{#if ready}
			{#if clearable}
				<button class="pill x" aria-label="Clear filters" title="Clear filters" onclick={() => onclear?.()} data-testid="pill-clear"><Icon name="close" size={16} /></button>
			{/if}
			{#each menus.filter((m) => !m.after) as m (m.key)}{@render menu(m)}{/each}
			{#each pills as p (p.group + ':' + p.value)}
				<button
					class="pill"
					class:on={p.active}
					aria-pressed={p.active}
					data-group={p.group}
					data-value={p.value}
					data-testid="pill"
					onclick={() => onpick?.(p.group, pick(byKey.get(p.group)!, p.value))}>{p.label}</button
				>
			{/each}
			{#each menus.filter((m) => m.after) as m (m.key)}{@render menu(m)}{/each}
		{/if}
	</div>
	{#if action}
		<button class="ibtn act" class:on={action.active} aria-label={action.label} title={action.label} aria-haspopup="dialog" onclick={action.onclick} data-testid="pill-action"><Icon name={action.icon} size={18} /></button>
	{/if}
</div>

<style>
	.pillbar {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 44px;
		margin: 2px 0 10px;
	}
	.scroll {
		flex: 1;
		min-width: 0;
		height: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		overflow-x: auto;
		scrollbar-width: none;
		overscroll-behavior-x: contain;
	}
	.scroll::-webkit-scrollbar {
		display: none;
	}
	.pill {
		flex: none;
		height: 32px;
		padding: 0 14px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		color: var(--text-1);
		font-size: 13px;
		font-weight: 650;
		white-space: nowrap;
		border: 1px solid transparent;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.pill.on {
		background: var(--accent);
		color: var(--on-accent);
	}
	.pill.menu.on {
		background: var(--accent-subtle);
		border-color: var(--accent);
		color: var(--text-1);
	}
	.pill.x {
		width: 32px;
		padding: 0;
		justify-content: center;
	}
	.act {
		flex: none;
		width: 36px;
		height: 36px;
	}
	.act.on {
		color: var(--accent);
	}
</style>
