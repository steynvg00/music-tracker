<script lang="ts">
	import { onMount } from 'svelte';
	import { apiDelete, apiGet, apiPost, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { WARN_PCT, fmtMB, type StorageLimits, type Usage } from '$lib/shared/media';

	/**
	 * v0.94 storage: Settings › Storage (full) and Data health (compact: usage + warning at 80 %).
	 * Shows the backend and limits, never a key or secret.
	 */
	let { compact = false }: { compact?: boolean } = $props();

	interface FileRow {
		id: string;
		purpose: 'track' | 'set' | 'cover';
		name: string | null;
		size: number;
		status: string;
		usedBy: string | null;
	}
	interface Info {
		configured: boolean;
		missing: string[];
		backend: string;
		endpointHost: string | null;
		bucket: string | null;
		region: string | null;
		limits: StorageLimits;
		uploadTtlS: number;
		playbackTtlS: number;
		usage: Usage;
		files: FileRow[] | null;
	}
	let info = $state<Info | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	async function load() {
		try {
			info = await apiGet<Info>(`/api/media/storage${compact ? '' : '?files=1'}`);
		} catch (e) {
			error = describeFailure(e);
		}
	}
	onMount(load);
	const tone = $derived(!info ? 'ok' : info.usage.full ? 'danger' : info.usage.warn ? 'warn' : 'ok');
	const COLOR = { ok: 'var(--accent)', warn: 'var(--warning)', danger: 'var(--danger)' };

	async function cleanup() {
		busy = true;
		try {
			const r = await apiPost<{ aborted: number; deleted: number; orphans: number }>('/api/media/storage');
			toasts.show(`Clean-up: ${r.aborted} unfinished upload(s) cancelled, ${r.deleted} file(s) removed`);
			await load();
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			busy = false;
		}
	}
	async function del(f: FileRow) {
		try {
			await apiDelete(`/api/media/${f.id}`);
			toasts.show(`Deleted ${f.name ?? 'the file'} from storage`);
			await load();
		} catch (e) {
			toasts.error(describeFailure(e));
		}
	}
</script>

<section class="section" aria-labelledby="h-storage" data-testid={compact ? 'health-storage' : 'settings-storage'}>
	<div class="sec-h"><h2 id="h-storage">{compact ? 'File storage' : 'Storage'}</h2>{#if compact}<a class="cap" href="/settings#h-storage">Settings › Storage</a>{/if}</div>
	{#if error}
		<p class="notice">{error}</p>
	{:else if !info}
		<div class="skel" style="height:40px;border-radius:8px"></div>
	{:else}
		{#if !info.configured}
			<p class="cap" style="color:var(--warning)" data-testid="storage-missing">Uploads are off: set {info.missing.join(', ')} in the hub’s server environment (see the v0.94 PR setup steps). YouTube and SoundCloud sources work without it.</p>
		{/if}
		<p class="cap" data-testid="storage-usage">
			<b class="tab-num">{fmtMB(info.usage.usedBytes)}</b> of {fmtMB(info.usage.quotaBytes)} · {info.usage.pct}% · {info.usage.files.track} track file{info.usage.files.track === 1 ? '' : 's'}, {info.usage.files.set} set{info.usage.files.set === 1 ? '' : 's'}, {info.usage.files.cover} cover{info.usage.files.cover === 1 ? '' : 's'}{info.usage.pending ? ` · ${info.usage.pending} unfinished` : ''}
		</p>
		<div class="meter" role="meter" aria-label="File storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.min(100, info.usage.pct)}>
			<i style="width:{Math.min(100, info.usage.pct)}%;background:{COLOR[tone]}"></i>
		</div>
		{#if info.usage.warn}
			<p class="warn" role="alert" data-testid="storage-warn">Above {WARN_PCT}% of your {fmtMB(info.usage.quotaBytes)} storage. Delete files you no longer need, or move to a bigger backend (scripts/migrate_media_storage.py).</p>
		{/if}
		{#if !compact}
			<dl class="kv">
				<dt>Backend</dt><dd data-testid="storage-backend">{info.backend}{info.endpointHost ? ` · ${info.endpointHost}` : ''}{info.bucket ? ` · bucket ${info.bucket}` : ''}{info.region ? ` · ${info.region}` : ''}</dd>
				<dt>Limits</dt><dd>Track {fmtMB(info.limits.trackBytes)} · set {fmtMB(info.limits.setBytes)} · cover {fmtMB(info.limits.coverBytes)} · total {fmtMB(info.limits.quotaBytes)}</dd>
				<dt>Uploads</dt><dd>Straight from this device to storage, in {fmtMB(info.limits.partBytes)} parts (resumable); links valid {Math.round(info.uploadTtlS / 60)} min</dd>
				<dt>Playback</dt><dd>Signed links valid {info.playbackTtlS >= 60 ? `${Math.round(info.playbackTtlS / 60)} min` : `${info.playbackTtlS} s`}, renewed automatically</dd>
			</dl>
			{#if info.backend === 'supabase' && info.limits.setBytes > 50 * 1048576}
				<p class="cap muted" data-testid="storage-supabase-note">Supabase’s free plan caps each file at 50 MB (Storage › Settings in the dashboard), so sets above that need Pro, or another backend (R2, MinIO), or MEDIA_MAX_SET_MB=50.</p>
			{/if}
			{#if info.configured}
				<button class="btn sec sm" disabled={busy} onclick={cleanup} data-testid="storage-cleanup">{busy ? 'Cleaning…' : 'Clean up unfinished uploads'}</button>
			{/if}
			{#if info.files?.length}
				<ul class="files" aria-label="Stored files">
					{#each info.files as f (f.id)}
						<li>
							<span class="ell">{f.name ?? f.id} · {fmtMB(f.size)} · {f.purpose}{f.status !== 'ready' ? ` · ${f.status}` : ''}{f.usedBy ? ` · ${f.usedBy}` : ' · not used'}</span>
							<button class="btn ghost sm" onclick={() => del(f)}>Delete</button>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.meter {
		height: 8px;
		border-radius: 4px;
		background: var(--surface-3);
		overflow: hidden;
		margin: 6px 0;
	}
	.meter i {
		display: block;
		height: 100%;
	}
	.warn {
		color: var(--warning);
		font-size: 13px;
	}
	.kv {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 12px;
		font-size: 14px;
	}
	dt {
		color: var(--text-3);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.files {
		list-style: none;
		padding: 0;
		margin: 10px 0 0;
	}
	.files li {
		display: flex;
		gap: 8px;
		align-items: center;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
	}
	.files .ell {
		flex: 1;
		min-width: 0;
	}
</style>
