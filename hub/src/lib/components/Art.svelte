<script lang="ts">
	import Icon from './Icon.svelte';
	/**
	 * Spotify artwork, untouched (no overlays, crop, blur or animation): 4 px radius up to
	 * 64 px, 8 px above (Spotify Design Guidelines). Missing art → surface-3 + note glyph.
	 */
	let { src, size, alt = '', shape }: { src: string | null | undefined; size: number; alt?: string; shape?: 's' | 'l' | 'circle' } = $props();
	let failed = $state(false);
	const cls = $derived(shape ?? (size > 64 ? 'l' : 's'));
</script>

<span class="art {cls}" style="width:{size}px;height:{size}px">
	{#if src && !failed}
		<img {src} {alt} loading="lazy" decoding="async" width={size} height={size} referrerpolicy="no-referrer" onerror={() => (failed = true)} />
	{:else}
		<span class="ph" style="--g:{Math.round(size * 0.4)}px"><Icon name="note" size={Math.round(size * 0.4)} /></span>
	{/if}
</span>

<style>
	.ph {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		color: var(--text-3);
	}
</style>
