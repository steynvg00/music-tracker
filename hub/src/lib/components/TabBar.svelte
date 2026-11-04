<script lang="ts">
	import { page } from '$app/state';
	import Icon, { type IconName } from './Icon.svelte';
	const tabs: { href: string; icon: IconName; label: string; match: RegExp }[] = [
		{ href: '/home', icon: 'home', label: 'Home', match: /^\/(home|daily)/ },
		{ href: '/search', icon: 'search', label: 'Search', match: /^\/search/ },
		{ href: '/library', icon: 'lib', label: 'Library', match: /^\/library/ },
		{ href: '/stats', icon: 'stats', label: 'Stats', match: /^\/stats/ }
	];
</script>

<nav class="tabbar" aria-label="Tabs">
	{#each tabs as t (t.href)}
		{@const on = t.match.test(page.url.pathname)}
		<a href={t.href} class:on aria-current={on ? 'page' : undefined}><Icon name={t.icon} /><span>{t.label}</span></a>
	{/each}
</nav>

<style>
	.tabbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 20;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		padding-bottom: var(--safe-bottom);
		background: rgba(19, 19, 23, 0.92);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		border-top: 1px solid var(--border);
	}
	a {
		height: var(--tabbar-h);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		color: var(--text-3);
		font-size: 11px;
		font-weight: 700;
	}
	a.on {
		color: var(--text-1);
	}
	a.on :global(svg) {
		stroke: var(--accent);
	}
	@media (min-width: 768px) {
		.tabbar {
			display: none;
		}
	}
</style>
