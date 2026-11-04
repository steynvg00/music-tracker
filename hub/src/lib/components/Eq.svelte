<script lang="ts">
	let { paused = false }: { paused?: boolean } = $props();
</script>

<span class="eq" class:paused aria-hidden="true"><i style="height:6px"></i><i style="height:12px"></i><i style="height:8px"></i></span>
