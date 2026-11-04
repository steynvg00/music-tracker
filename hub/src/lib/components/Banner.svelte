<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	let { kind = 'warning', children }: { kind?: 'warning' | 'danger' | 'info'; children: Snippet } = $props();
</script>

<div class="banner {kind}" role={kind === 'danger' ? 'alert' : 'status'}>
	<Icon name="alert" size={18} />
	<div class="body">{@render children()}</div>
</div>

<style>
	.banner {
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 10px 12px;
		border-radius: var(--r-card);
		margin: 8px 0 4px;
		font-size: 13px;
		line-height: 18px;
	}
	.body {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: space-between;
	}
	.warning {
		background: rgba(255, 181, 71, 0.1);
		border: 1px solid rgba(255, 181, 71, 0.3);
		color: var(--warning);
	}
	.danger {
		background: rgba(255, 92, 122, 0.1);
		border: 1px solid rgba(255, 92, 122, 0.35);
		color: var(--danger);
	}
	.info {
		background: rgba(108, 184, 255, 0.08);
		border: 1px solid rgba(108, 184, 255, 0.25);
		color: var(--info);
	}
	.body :global(span) {
		color: var(--text-1);
	}
</style>
