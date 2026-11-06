<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import JobStatus from '$lib/components/JobStatus.svelte';
	import StatsNav from '$lib/components/stats/StatsNav.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { JobTracker } from '$lib/stores/jobs.svelte';
	import { apiPost, describeFailure, ApiFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { fmtDate } from '$lib/shared/format';
	import type { JobRow } from '$lib/shared/jobs';

	let { data } = $props();
	const list = $derived(data.r.data);
	const tracker = new JobTracker((job) => {
		if (job.status === 'done') void invalidateAll();
	});
	let busyYear = $state<number | null>(null);
	const current = $derived(list?.years.find((y) => y.status === 'so_far') ?? null);

	async function build(year: number) {
		busyYear = year;
		try {
			const r = await apiPost<{ mode: 'job'; job: JobRow } | { mode: 'inline' }>(`/api/wrapped/${year}/freeze`);
			if (r.mode === 'job') tracker.track(r.job);
			else {
				toasts.show(`Rotor Wrapped ${year} is ready`);
				await invalidateAll();
			}
		} catch (e) {
			toasts.error(e instanceof ApiFailure ? (e.body.message ?? describeFailure(e)) : describeFailure(e));
		} finally {
			busyYear = null;
		}
	}
</script>

<svelte:head><title>Rotor · Wrapped</title></svelte:head>

<div class="view">
	<Header title="Rotor Wrapped" />
	<StatsNav />
	{#if !list}
		<StatsError r={data.r} />
	{:else}
		{#if current}
			<a class="hero" href="/wrapped/{current.year}">
				<span class="over">Rotor Wrapped</span>
				<strong>{current.year} so far</strong>
				<span class="cap">Live through today · tap to play the story</span>
			</a>
		{/if}
		<section class="section">
			<div class="sec-h"><h2>Pick a year</h2></div>
			<p class="cap muted">Full calendar years, built once on 1 January and then frozen. Older years can be built here.</p>
			<ul class="years">
				{#each list.years.filter((y) => y.status !== 'so_far') as y (y.year)}
					<li data-year={y.year} data-status={y.status}>
						<span class="yr">{y.year}</span>
						{#if y.status === 'frozen'}
							<span class="chip">Frozen {y.generatedAt ? fmtDate(y.generatedAt, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</span>
							<a class="btn pri" href="/wrapped/{y.year}">Open</a>
						{:else}
							<span class="chip dim">Not built</span>
							<button class="btn" onclick={() => build(y.year)} disabled={busyYear !== null || !!tracker.view?.busy}>{busyYear === y.year ? 'Building…' : 'Build'}</button>
						{/if}
					</li>
				{/each}
			</ul>
			{#if tracker.job}<JobStatus {tracker} />{/if}
		</section>
	{/if}
</div>

<style>
	.hero {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 24px;
		border-radius: 16px;
		background: linear-gradient(160deg, #3b1f7a, var(--bg) 75%);
		margin-bottom: 16px;
	}
	.hero strong {
		font-size: 34px;
		font-weight: 800;
		color: var(--text-1);
	}
	.over {
		color: var(--accent);
		font-weight: 700;
		font-size: 13px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.years {
		list-style: none;
		padding: 0;
		margin: 12px 0;
		display: grid;
		gap: 8px;
	}
	.years li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		border-radius: 12px;
		background: var(--surface-2);
	}
	.yr {
		font-size: 20px;
		font-weight: 800;
		min-width: 64px;
	}
	.chip {
		flex: 1;
		color: var(--text-2);
		font-size: 13px;
	}
	.chip.dim {
		color: var(--text-3);
	}
	.muted {
		color: var(--text-3);
	}
</style>
