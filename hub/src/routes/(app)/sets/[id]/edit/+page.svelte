<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import SetForm from '$lib/components/own/SetForm.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Rotor · Edit set</title></svelte:head>
<div class="view">
	<Header title="Edit set" />
	{#if data.r.data}{#key data.r.data.id}<SetForm set={data.r.data} />{/key}{:else}<StatsError r={data.r} />{/if}
</div>
