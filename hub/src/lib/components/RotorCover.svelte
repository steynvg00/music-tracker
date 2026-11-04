<script lang="ts">
	import RotorMark from './RotorMark.svelte';
	/**
	 * Rotor's own cover for generated picks (own artwork, so the title may sit on it;
	 * never on Spotify album art). Gradient keyed to the recipe, deterministic.
	 */
	let { title, recipe, size }: { title: string; recipe: string | null; size: number } = $props();
	const GRADIENTS: Record<string, [string, string]> = {
		forgotten_gems: ['hsl(265 70% 55%)', 'hsl(235 65% 22%)'],
		fresh_heat: ['hsl(320 70% 52%)', 'hsl(38 85% 30%)'],
		evergreen_core: ['hsl(188 70% 45%)', 'hsl(235 60% 22%)'],
		artist_deep_dive: ['hsl(38 85% 52%)', 'hsl(345 60% 26%)'],
		discovered_in_year: ['hsl(160 55% 42%)', 'hsl(250 55% 22%)']
	};
	const g = $derived(GRADIENTS[recipe ?? ''] ?? ['hsl(262 60% 50%)', 'hsl(262 50% 18%)']);
</script>

<span class="art {size > 64 ? 'l' : 's'} rc" style="width:{size}px;height:{size}px;background:linear-gradient(145deg,{g[0]},{g[1]})">
	<span class="mark"><RotorMark size={Math.round(size * 0.7)} /></span>
	{#if size >= 96}<b>{title}</b>{/if}
</span>

<style>
	.rc {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		padding: 10px;
		color: #fff;
	}
	.mark {
		position: absolute;
		right: -14%;
		top: -14%;
		opacity: 0.22;
	}
	b {
		position: relative;
		font-size: 15px;
		line-height: 18px;
		font-weight: 800;
		letter-spacing: -0.01em;
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.25);
	}
</style>
