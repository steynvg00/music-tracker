<script lang="ts">
	import { onMount } from 'svelte';
	import JobStatus from '$lib/components/JobStatus.svelte';
	import { JobTracker } from '$lib/stores/jobs.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { apiGet, apiPost, apiPut, describeFailure } from '$lib/player/api-client';
	import type { JobRow } from '$lib/shared/jobs';
	import type { NotificationKind, NotificationPref } from '$lib/shared/notifications';
	/**
	 * Settings › Notifications › types (R9): every former mail is a push now. One switch and one
	 * "Send test" per type; a test is sent even when the type is off.
	 */
	let { jobsAvailable }: { jobsAvailable: boolean } = $props();
	let prefs = $state<NotificationPref[] | null>(null);
	let stored = $state(true);
	let busy = $state<NotificationKind | null>(null);
	let testing = $state<NotificationKind | null>(null);
	const tracker = new JobTracker(() => undefined);

	onMount(() => {
		void apiGet<{ prefs: NotificationPref[]; stored: boolean }>('/api/notifications')
			.then((r) => ((prefs = r.prefs), (stored = r.stored)))
			.catch((e) => toasts.error(describeFailure(e)));
	});

	async function toggle(p: NotificationPref) {
		busy = p.kind;
		try {
			const r = await apiPut<{ prefs: NotificationPref[]; stored: boolean }>('/api/notifications', { kind: p.kind, enabled: !p.enabled });
			prefs = r.prefs;
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			busy = null;
		}
	}
	async function test(kind: NotificationKind) {
		testing = kind;
		try {
			tracker.track((await apiPost<{ job: JobRow }>('/api/notifications/test', { kind })).job);
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
</script>

<div class="types" data-testid="notification-types">
	<h3 class="cap"><b>Types</b></h3>
	{#if !stored}<p class="cap muted">Switches need migration 0030; until then every type is on.</p>{/if}
	{#if prefs}
		<ul>
			{#each prefs as p (p.kind)}
				<li data-kind={p.kind}>
					<label class="sw">
						<input type="checkbox" role="switch" checked={p.enabled} disabled={busy === p.kind || !stored} onchange={() => toggle(p)} aria-describedby="nt-{p.kind}" />
						<span class="l"><span>{p.label}</span>{#if p.wasMail}<span class="cap muted" id="nt-{p.kind}">was a mail</span>{:else}<span class="sr" id="nt-{p.kind}">push</span>{/if}</span>
					</label>
					<button class="btn sec sm" disabled={!jobsAvailable || !!tracker.view?.busy} onclick={() => test(p.kind)} aria-label="Send a test: {p.label}">Send test</button>
				</li>
			{/each}
		</ul>
		{#if testing}<JobStatus {tracker} />{/if}
	{:else}
		<p class="cap muted">Loading…</p>
	{/if}
</div>

<style>
	ul {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
	}
	.sw {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		flex: 1;
		min-width: 0;
	}
	.sw input {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
		flex: none;
	}
	.l {
		display: flex;
		flex-direction: column;
	}
	.sm {
		height: 32px;
		padding: 0 12px;
		font-size: 12px;
	}
	.types {
		margin-top: 14px;
	}
</style>
