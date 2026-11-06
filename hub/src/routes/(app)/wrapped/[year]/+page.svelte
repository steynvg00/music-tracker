<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import Header from '$lib/components/Header.svelte';
	import JobStatus from '$lib/components/JobStatus.svelte';
	import Story from '$lib/components/wrapped/Story.svelte';
	import { JobTracker } from '$lib/stores/jobs.svelte';
	import { apiPost, describeFailure, ApiFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import type { JobRow } from '$lib/shared/jobs';

	let { data } = $props();
	const w = $derived(data.r.data);
	const tracker = new JobTracker((job) => {
		if (job.status === 'done') void invalidateAll();
	});
	let building = $state(false);

	// Back to where the story was opened from (?from=/home); only same-site paths.
	function close() {
		const from = page.url.searchParams.get('from');
		void goto(from && from.startsWith('/') && !from.startsWith('//') ? from : '/stats/wrapped');
	}

	async function build() {
		building = true;
		try {
			const r = await apiPost<{ mode: 'job'; job: JobRow } | { mode: 'inline' }>(`/api/wrapped/${data.year}/freeze`);
			if (r.mode === 'job') tracker.track(r.job);
			else await invalidateAll();
		} catch (e) {
			toasts.error(e instanceof ApiFailure ? (e.body.message ?? describeFailure(e)) : describeFailure(e));
		} finally {
			building = false;
		}
	}
</script>

<svelte:head><title>Rotor Wrapped {data.year}</title></svelte:head>

{#if w}
	<Story payload={w.payload} mode={w.mode} playlistName={w.playlistName} onclose={close} />
{:else}
	<div class="view">
		<Header title="Rotor Wrapped {data.year}" />
		{#if data.r.status === 404}
			<section class="section empty">
				<p>Rotor Wrapped {data.year} isn't built yet. Building freezes the year: it never changes afterwards.</p>
				<div class="acts">
					<button class="btn pri" onclick={build} disabled={building || !!tracker.view?.busy}>Build Rotor Wrapped {data.year}</button>
					<a class="btn" href="/stats/wrapped">All years</a>
				</div>
				{#if tracker.job}<JobStatus {tracker} />{/if}
			</section>
		{:else}
			<p class="notice">{data.r.message ?? 'Rotor Wrapped is unavailable.'}</p>
			<a class="btn" href="/stats/wrapped">All years</a>
		{/if}
	</div>
{/if}

<style>
	.empty p {
		color: var(--text-2);
		max-width: 52ch;
	}
	.acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 12px 0;
	}
</style>
