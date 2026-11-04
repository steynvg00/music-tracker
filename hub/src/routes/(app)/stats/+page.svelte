<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import RotorMark from '$lib/components/RotorMark.svelte';
</script>

<svelte:head><title>Rotor · Stats</title></svelte:head>

<div class="view">
	<Header title="Stats" />
	<div class="empty">
		<span class="muted"><RotorMark size={64} /></span>
		<p>Stats parity with the Streamlit dashboard arrives in R3. Until then the dashboard has them.</p>
		<a class="btn sec" href="/home">Back to Home</a>
	</div>
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		text-align: center;
		padding: 48px 16px;
		color: var(--text-2);
		max-width: 420px;
		margin: 0 auto;
	}
</style>
