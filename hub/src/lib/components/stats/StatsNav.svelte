<script lang="ts">
	import { page } from '$app/state';
	import { STATS_SECTIONS } from '$lib/shared/stats';
	/** Section chips under the Stats header (Overview · Top · Patterns · …). */
	const current = $derived(page.url.pathname.replace(/\/$/, '') || '/stats');
</script>

<nav class="sn" aria-label="Stats sections">
	{#each STATS_SECTIONS as s (s.key)}
		<a href={s.href} aria-current={current === s.href ? 'page' : undefined} class:on={current === s.href}>{s.label}</a>
	{/each}
</nav>

<style>
	.sn {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		scrollbar-width: none;
		margin: 4px calc(-1 * var(--gutter)) 12px;
		padding: 0 var(--gutter);
	}
	a {
		flex: none;
		padding: 7px 14px;
		border-radius: var(--r-pill);
		background: var(--surface-2);
		color: var(--text-2);
		font-size: 13px;
		font-weight: 600;
		min-height: 36px;
		display: inline-flex;
		align-items: center;
	}
	a.on {
		background: var(--accent);
		color: var(--on-accent);
	}
</style>
