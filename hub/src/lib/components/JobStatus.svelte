<script lang="ts">
	import Icon from './Icon.svelte';
	import type { JobTracker } from '$lib/stores/jobs.svelte';
	/** One job's state: Queued → Running → Done / Failed (+ Retry). Text labels, never colour alone. */
	let { tracker }: { tracker: JobTracker } = $props();
	const v = $derived(tracker.view);
	const job = $derived(tracker.job);
</script>

{#if v && job}
	<div class="job {v.tone}" role="status" aria-live="polite" data-status={job.status}>
		{#if v.busy}<span class="spin"></span>{:else if v.tone === 'success'}<span class="dot ok"></span>{:else}<span class="dot bad"></span>{/if}
		<span class="txt"><b>{v.label}</b>{#if v.detail}<span class="cap"> · {v.detail}</span>{/if}</span>
		{#if v.canRetry}<button class="btn sec small" onclick={() => tracker.retry()}><Icon name="rotate" size={14} /> Retry</button>{/if}
		{#if job.runUrl}<a class="cap run" href={job.runUrl} target="_blank" rel="noopener noreferrer">Run log</a>{/if}
	</div>
{/if}

<style>
	.job {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		border-radius: var(--r-card);
		background: var(--surface-2);
		font-size: 13px;
		flex-wrap: wrap;
	}
	.job.danger {
		background: rgba(255, 92, 122, 0.1);
	}
	.txt {
		flex: 1;
		min-width: 0;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}
	.dot.ok {
		background: var(--success);
	}
	.dot.bad {
		background: var(--danger);
	}
	.small {
		height: 32px;
		padding: 0 12px;
		font-size: 13px;
	}
	.run {
		text-decoration: underline;
	}
</style>
