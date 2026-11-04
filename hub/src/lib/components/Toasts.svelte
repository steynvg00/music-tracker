<script lang="ts">
	import { toasts } from '$lib/stores/toasts.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
	{#each toasts.items as t (t.id)}
		<div class="toast" class:error={t.kind === 'error'}>
			<span>{t.message}</span>
			{#if t.action}<button
					onclick={() => {
						t.action!.run();
						toasts.dismiss(t.id);
					}}>{t.action.label}</button
				>{/if}
		</div>
	{/each}
</div>

<style>
	.toasts {
		position: fixed;
		z-index: 70;
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(var(--tabbar-h) + var(--mini-h) + var(--safe-bottom) + 20px);
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: center;
		width: calc(100% - 32px);
		max-width: 420px;
		pointer-events: none;
	}
	.toast {
		background: var(--text-1);
		color: #111;
		font-weight: 700;
		font-size: 14px;
		padding: 10px 16px;
		border-radius: var(--r-card);
		box-shadow: var(--shadow-pop);
		display: flex;
		gap: 12px;
		align-items: center;
		pointer-events: auto;
		animation: tin var(--t-std) var(--ease-std);
	}
	.toast.error {
		background: #ffd6de;
	}
	.toast button {
		font-weight: 800;
		text-decoration: underline;
	}
	@keyframes tin {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	@media (min-width: 768px) {
		.toasts {
			bottom: 104px;
		}
	}
</style>
