<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import OwnTrackForm from '$lib/components/own/OwnTrackForm.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Rotor · Edit own track</title></svelte:head>
<div class="view">
	<Header title="Edit own track" />
	{#if data.r.data}{#key data.r.data.id}<OwnTrackForm track={data.r.data} />{/key}{:else}<StatsError r={data.r} />{/if}
</div>
