<script lang="ts">
	import { AUDIO_ACCEPT, IMAGE_ACCEPT, checkFile, fmtMB, type Purpose, type StorageLimits } from '$lib/shared/media';
	import { UploadAborted, discardUpload, pendingFor, readDuration, uploadFile, type Progress } from '$lib/upload';
	import { describeFailure, ApiFailure } from '$lib/player/api-client';

	/**
	 * One file → storage, directly (v0.94). Progress bar, cancel, and resume after an interruption
	 * (pick the same file again; also after a reload). Reads an audio file's duration locally.
	 */
	let {
		purpose,
		limits,
		label,
		current = null,
		onready,
		onremove
	}: {
		purpose: Purpose;
		limits: StorageLimits | null;
		label: string;
		/** An already attached file (edit). */
		current?: { id: string; name: string | null; size: number } | null;
		onready: (r: { id: string; name: string; size: number; durationMs: number | null }) => void;
		onremove?: () => void;
	} = $props();

	let file = $state<File | null>(null);
	let progress = $state<Progress | null>(null);
	let error = $state<string | null>(null);
	let phase = $state<'idle' | 'uploading' | 'interrupted' | 'done'>('idle');
	let ctrl: AbortController | null = null;
	let input = $state<HTMLInputElement | null>(null);
	const testid = $derived(`upload-${purpose}`);

	async function pick(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		error = null;
		if (limits) {
			const c = checkFile(purpose, f, limits);
			if (!c.ok) {
				error = c.error;
				if (input) input.value = '';
				return;
			}
		}
		file = f;
		await start();
	}

	async function start() {
		if (!file) return;
		const f = file;
		phase = 'uploading';
		error = null;
		ctrl = new AbortController();
		const duration = purpose === 'cover' ? Promise.resolve(null) : readDuration(f);
		try {
			const id = await uploadFile(f, purpose, { onProgress: (p) => (progress = p), signal: ctrl.signal });
			phase = 'done';
			onready({ id, name: f.name, size: f.size, durationMs: await duration });
		} catch (e) {
			if (e instanceof UploadAborted) return;
			phase = 'interrupted';
			error = e instanceof ApiFailure ? describeFailure(e) : e instanceof Error ? e.message : 'Upload failed';
		}
	}

	async function cancel() {
		ctrl?.abort();
		if (file) await discardUpload(file, purpose, pendingFor(file, purpose));
		file = null;
		progress = null;
		phase = 'idle';
		error = null;
		if (input) input.value = '';
	}
</script>

<div class="up" data-testid={testid}>
	<span class="lbl">{label}</span>
	{#if current && phase === 'idle'}
		<div class="cur">
			<span class="ell">{current.name ?? 'Uploaded file'} · {fmtMB(current.size)}</span>
			<button type="button" class="btn ghost sm" onclick={() => input?.click()}>Replace</button>
			{#if onremove}<button type="button" class="btn ghost sm" onclick={onremove}>Remove</button>{/if}
		</div>
	{/if}
	<input
		bind:this={input}
		class:sr={!!current || phase !== 'idle'}
		type="file"
		accept={purpose === 'cover' ? IMAGE_ACCEPT : AUDIO_ACCEPT}
		onchange={pick}
		disabled={!limits}
		aria-label={label}
		data-testid="{testid}-input"
	/>
	{#if phase !== 'idle' && file}
		<div class="bar" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.pct ?? 0} data-testid="{testid}-progress">
			<i style="width:{progress?.pct ?? 0}%"></i>
		</div>
		<p class="cap muted" aria-live="polite" data-testid="{testid}-status">
			{#if phase === 'uploading'}
				{progress?.phase === 'finishing' ? 'Finishing…' : `${progress?.resumed ? 'Resuming · ' : ''}${progress?.pct ?? 0}% of ${fmtMB(file.size)}`}
			{:else if phase === 'done'}
				Uploaded · {file.name}
			{:else if phase === 'interrupted'}
				Interrupted at {progress?.pct ?? 0}%.
			{/if}
		</p>
		<div class="acts">
			{#if phase === 'uploading'}<button type="button" class="btn ghost sm" onclick={cancel} data-testid="{testid}-cancel">Cancel</button>{/if}
			{#if phase === 'interrupted'}
				<button type="button" class="btn sec sm" onclick={start} data-testid="{testid}-resume">Resume</button>
				<button type="button" class="btn ghost sm" onclick={cancel}>Discard</button>
			{/if}
			{#if phase === 'done'}<button type="button" class="btn ghost sm" onclick={cancel}>Use another file</button>{/if}
		</div>
	{/if}
	{#if error}<p class="err" role="alert">{error}</p>{/if}
	{#if limits && phase === 'idle' && !current}
		<p class="cap muted">
			{purpose === 'cover' ? 'JPG, PNG or WebP' : 'MP3, M4A, AAC, FLAC or WAV'}, up to {fmtMB(purpose === 'track' ? limits.trackBytes : purpose === 'set' ? limits.setBytes : limits.coverBytes)}. Goes straight to your private storage.
		</p>
	{/if}
	{#if !limits}<p class="cap muted">Uploads aren’t set up yet (Settings › Storage).</p>{/if}
</div>

<style>
	.up {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.lbl {
		font-weight: 600;
		font-size: 14px;
	}
	.cur {
		display: flex;
		gap: 8px;
		align-items: center;
		min-width: 0;
	}
	.cur .ell {
		flex: 1;
		min-width: 0;
	}
	.bar {
		height: 6px;
		border-radius: 3px;
		background: var(--surface-3);
		overflow: hidden;
	}
	.bar i {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.2s;
	}
	.acts {
		display: flex;
		gap: 8px;
	}
	.err {
		color: var(--danger, #e5534b);
		font-size: 13px;
		margin: 0;
	}
	input[type='file'] {
		font: inherit;
		color: var(--text-2);
		max-width: 100%;
	}
</style>
