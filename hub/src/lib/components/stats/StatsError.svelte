<script lang="ts">
	/** Error/empty state for stats pages: names the cause (e.g. migration 0023 missing, offline). */
	let { r }: { r: { status: number; message: string | null } } = $props();
	const text = $derived(
		r.status === 503
			? 'Stats need migration 0023 (hub stats rollups). Apply it in the Supabase SQL editor, then reload.'
			: r.status === 404
				? 'Not in your listening history.'
				: r.status === 0
					? 'You’re offline. Stats need a connection.'
					: `Couldn’t load this (${r.message ?? r.status}).`
	);
</script>

<p class="notice" role="status">{text}</p>
