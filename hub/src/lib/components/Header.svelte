<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	/** Screen header: title · page actions (v0.91, e.g. Library's search / + / Manage) · health dot · settings. Sticky on mobile. */
	let {
		title,
		health = 'ok',
		healthLabel = 'All good',
		actions
	}: { title: string; health?: 'ok' | 'warn' | 'danger' | 'checking'; healthLabel?: string; actions?: Snippet } = $props();
</script>

<header class="mhead">
	<h1>{title}</h1>
	{#if actions}{@render actions()}{/if}
	<a class="health {health}" href="/settings" aria-label="Data health: {healthLabel}" title={healthLabel}><i></i></a>
	<a class="ibtn" href="/settings" aria-label="Settings"><Icon name="gear" size={20} /></a>
</header>

<style>
	.mhead {
		position: sticky;
		top: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: calc(var(--safe-top) + 12px) var(--gutter) 12px;
		margin: 0 calc(-1 * var(--gutter));
		background: var(--bg);
	}
	h1 {
		font-size: 24px;
		line-height: 28px;
		font-weight: 800;
		letter-spacing: -0.02em;
		flex: 1;
	}
	.health {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border-radius: 50%;
	}
	.health i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--success);
		box-shadow: 0 0 0 4px rgba(60, 207, 176, 0.15);
	}
	.health.warn i {
		background: var(--warning);
		box-shadow: 0 0 0 4px rgba(255, 181, 71, 0.15);
	}
	.health.danger i {
		background: var(--danger);
		box-shadow: 0 0 0 4px rgba(255, 92, 122, 0.15);
	}
	.health.checking i {
		animation: pulse 1.2s infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.4;
		}
	}
	@media (min-width: 768px) {
		.mhead {
			padding: 16px var(--gutter) 12px;
			background: var(--surface-1);
		}
		h1 {
			font-size: 32px;
			line-height: 36px;
		}
	}
</style>
