<script lang="ts">
	/** Rotor's mark: a circle with three curved blades. Own artwork (05-design.md §1). */
	let { size = 28 }: { size?: number } = $props();
</script>

<svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" style="flex:none">
	<circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2.4" />
	<path
		d="M16 16c0-6 3-9.5 7.5-9.8M16 16c5.2 3 6.5 7.4 4.3 11.3M16 16c-5.2 3-9.7 2-12-1.8"
		fill="none"
		stroke="currentColor"
		stroke-width="2.4"
		stroke-linecap="round"
	/>
	<circle cx="16" cy="16" r="2.6" fill="currentColor" />
</svg>
