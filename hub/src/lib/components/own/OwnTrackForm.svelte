<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import ArtistPicker from './ArtistPicker.svelte';
	import Uploader from './Uploader.svelte';
	import EmbedPlayer from './EmbedPlayer.svelte';
	import { ApiFailure, apiGet, apiPost, apiPut, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import {
		OWN_STATUS,
		ROLE_LABEL,
		STATUS_LABEL,
		VERSIONS,
		emptyInput,
		fmtClock,
		parseDuration,
		soundcloudUrl,
		validateOwnTrack,
		youtubeId,
		type ArtistLink,
		type DuplicateMatch,
		type Errors,
		type OwnTrack,
		type Role
	} from '$lib/shared/own';
	import type { StorageLimits } from '$lib/shared/media';
	import type { DjSetSummary } from '$lib/shared/sets';

	/**
	 * Add / edit an own track (v0.94). Nothing is saved with a missing or placeholder value: the same
	 * rules run here and on the server. Prefill only SUGGESTS; every field is confirmed with its own "Use".
	 */
	let { track = null }: { track?: OwnTrack | null } = $props();

	const t0 = untrack(() => track);
	const init = emptyInput();
	if (t0) {
		Object.assign(init, {
			title: t0.title,
			version: t0.version,
			status: t0.status,
			durationMs: t0.durationMs,
			artists: structuredClone(t0.artists),
			label: t0.label,
			dateKind: t0.dateKind,
			date: t0.date,
			heardSetId: t0.heardSet?.id ?? null,
			heardAtMs: t0.heardAtMs,
			heardNote: t0.heardNote,
			notes: t0.notes,
			coverUrl: t0.coverUrl,
			coverObjectId: t0.coverObjectId,
			youtubeUrl: t0.youtubeId ? `https://www.youtube.com/watch?v=${t0.youtubeId}` : null,
			soundcloudUrl: t0.soundcloudUrl,
			audioObjectId: t0.audio?.id ?? null
		});
	}
	let f = $state(init);
	let duration = $state(t0 ? fmtClock(t0.durationMs) : '');
	let heardAt = $state(t0?.heardAtMs !== null && t0?.heardAtMs !== undefined ? fmtClock(t0.heardAtMs) : '');
	let errors = $state<Errors>({});
	let touched = $state(false);
	let saving = $state(false);
	let dupes = $state<DuplicateMatch[]>([]);
	let confirmDupe = $state(false);
	let limits = $state<StorageLimits | null>(null);
	let sets = $state<DjSetSummary[]>([]);
	let durationHint = $state<string | null>(null);
	let audioMeta = $state<{ id: string; name: string | null; size: number } | null>(t0?.audio ? { id: t0.audio.id, name: t0.audio.name, size: t0.audio.size } : null);
	let coverMeta = $state<{ id: string; name: string | null; size: number } | null>(t0?.coverObjectId ? { id: t0.coverObjectId, name: 'Cover', size: 0 } : null);

	onMount(async () => {
		const [st, ss] = await Promise.allSettled([apiGet<{ configured: boolean; limits: StorageLimits }>('/api/media/storage'), apiGet<{ sets: DjSetSummary[] }>('/api/sets')]);
		if (st.status === 'fulfilled' && st.value.configured) limits = st.value.limits;
		if (ss.status === 'fulfilled') sets = ss.value.sets;
	});

	const body = () => ({ ...f, durationMs: parseDuration(duration), heardAtMs: heardAt.trim() ? heardAt.trim() : null, confirmDuplicate: confirmDupe });
	$effect(() => {
		// Live re-validation once you tried to save (errors disappear as you fix them).
		const b = body();
		if (!touched) return;
		const v = validateOwnTrack(b);
		errors = v.ok ? {} : v.errors;
	});

	const yt = $derived(youtubeId(f.youtubeUrl));
	const sc = $derived(soundcloudUrl(f.soundcloudUrl));

	function setDuration(ms: number | null, from: string) {
		if (!ms) return;
		if (!duration.trim()) {
			duration = fmtClock(ms);
			durationHint = `Read from ${from}: ${fmtClock(ms)}`;
		} else if (parseDuration(duration) !== ms) durationHint = `${from} says ${fmtClock(ms)}`;
	}

	// ── duplicates (live) ──
	let dupTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const title = f.title.trim();
		const names = f.artists.primary.map((a) => a.name);
		const version = f.version;
		clearTimeout(dupTimer);
		if (!title || !names.length) {
			dupes = [];
			return;
		}
		dupTimer = setTimeout(async () => {
			try {
				dupes = (await apiPost<{ matches: DuplicateMatch[] }>('/api/own/duplicates', { title, version, artists: names, excludeId: track?.id ?? null })).matches;
			} catch {
				dupes = [];
			}
		}, 400);
	});

	// ── prefill ──
	interface SugArtist {
		name: string;
		link: ArtistLink | null;
	}
	interface Suggestion {
		source: 'embed' | 'musicbrainz' | 'spotify';
		title: string | null;
		version: string | null;
		artists: SugArtist[];
		featuring: SugArtist[];
		remixer: SugArtist | null;
		durationMs: number | null;
		date: string | null;
		label: string | null;
		coverUrl: string | null;
		ref: string | null;
	}
	let sugs = $state<Suggestion[] | null>(null);
	let sugErrors = $state<string[]>([]);
	let prefilling = $state(false);
	const SRC_LABEL = { embed: 'Embed title', musicbrainz: 'MusicBrainz', spotify: 'Spotify catalog' };
	async function prefill() {
		prefilling = true;
		try {
			const r = await apiPost<{ suggestions: Suggestion[]; errors: Record<string, string> }>('/api/own/prefill', {
				title: f.title,
				artist: f.artists.primary[0]?.name ?? '',
				youtubeUrl: f.youtubeUrl,
				soundcloudUrl: f.soundcloudUrl
			});
			sugs = r.suggestions;
			sugErrors = Object.values(r.errors);
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			prefilling = false;
		}
	}
	function useArtists(role: Role, list: SugArtist[]) {
		const linked = list.filter((a) => a.link).map((a) => a.link!);
		const merged = [...f.artists[role]];
		for (const l of linked) if (!merged.some((m) => m.kind === l.kind && m.id === l.id)) merged.push(l);
		f.artists[role] = merged;
	}
	async function createAndUse(role: Role, a: SugArtist) {
		try {
			const link = await apiPost<ArtistLink>('/api/own/artists', { name: a.name });
			a.link = link;
			useArtists(role, [a]);
		} catch (e) {
			const ex = e instanceof ApiFailure ? (e.body.detail?.existing as ArtistLink | undefined) : undefined;
			if (ex) {
				a.link = ex;
				useArtists(role, [a]);
			} else toasts.error(describeFailure(e));
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		touched = true;
		const b = body();
		const v = validateOwnTrack(b);
		if (!v.ok) {
			errors = v.errors;
			queueMicrotask(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
			return;
		}
		saving = true;
		try {
			const t = track ? await apiPut<OwnTrack>(`/api/own/${track.id}`, b) : await apiPost<OwnTrack>('/api/own', b);
			toasts.show(track ? 'Saved' : `Added “${t.title}” · in Rotor only`);
			await goto(`/own/${t.id}`);
		} catch (err) {
			if (err instanceof ApiFailure && err.body.error === 'duplicate') {
				dupes = (err.body.matches ?? []) as DuplicateMatch[];
				toasts.error('Possible duplicate: check below, then “Save anyway”');
			} else if (err instanceof ApiFailure && err.body.fields) errors = err.body.fields as Errors;
			else toasts.error(describeFailure(err));
		} finally {
			saving = false;
		}
	}
	const roleLists = (s: Suggestion): { role: Role; list: SugArtist[] }[] => [
		{ role: 'primary', list: s.artists },
		{ role: 'featuring', list: s.featuring },
		{ role: 'remixer', list: s.remixer ? [s.remixer] : [] }
	];
	const OTHER_ROLES: Role[] = ['featuring', 'remixer', 'producer'];
</script>

<form class="form" onsubmit={save} novalidate data-testid="own-form">
	<fieldset>
		<legend>Source <span class="req">at least one</span></legend>
		<label for="ot-yt">YouTube link</label>
		<input id="ot-yt" type="url" inputmode="url" bind:value={f.youtubeUrl} placeholder="https://www.youtube.com/watch?v=…" aria-invalid={!!errors.youtube} />
		{#if errors.youtube}<p class="err">{errors.youtube}</p>{/if}
		<label for="ot-sc">SoundCloud link</label>
		<input id="ot-sc" type="url" inputmode="url" bind:value={f.soundcloudUrl} placeholder="https://soundcloud.com/…" aria-invalid={!!errors.soundcloud} />
		{#if errors.soundcloud}<p class="err">{errors.soundcloud}</p>{/if}
		<Uploader
			purpose="track"
			{limits}
			label="Audio file"
			current={audioMeta}
			onready={(r) => {
				f.audioObjectId = r.id;
				audioMeta = { id: r.id, name: r.name, size: r.size };
				setDuration(r.durationMs, 'the file');
			}}
			onremove={() => {
				f.audioObjectId = null;
				audioMeta = null;
			}}
		/>
		{#if errors.source}<p class="err" role="alert" data-testid="err-source">{errors.source}</p>{/if}
		{#if yt || sc}
			<EmbedPlayer youtubeId={yt} soundcloudUrl={yt ? null : sc} title={f.title || 'Preview'} onduration={(ms) => setDuration(ms, yt ? 'YouTube' : 'SoundCloud')} />
		{/if}
		<button type="button" class="btn sec sm" onclick={prefill} disabled={prefilling || (!f.title.trim() && !yt && !sc)} data-testid="prefill">{prefilling ? 'Looking…' : 'Suggest metadata'}</button>
		{#if sugs}
			<div class="sugs" data-testid="suggestions">
				{#each sugErrors as m (m)}<p class="cap muted">{m}</p>{/each}
				{#if !sugs.length}<p class="cap muted">No suggestions found.</p>{/if}
				{#each sugs as s, i (i)}
					<div class="sug" data-source={s.source}>
						<p class="cap"><b>{SRC_LABEL[s.source]}</b>{#if s.ref} · <span class="muted ell">{s.ref}</span>{/if}</p>
						<ul>
							{#if s.title}<li><span>Title: {s.title}</span><button type="button" class="btn ghost sm" onclick={() => (f.title = s.title!)}>Use</button></li>{/if}
							{#if s.version}<li><span>Version: {s.version}</span><button type="button" class="btn ghost sm" onclick={() => (f.version = s.version)}>Use</button></li>{/if}
							{#each roleLists(s) as { role, list } (role)}
								{#each list as a (a.name)}
									<li>
										<span>{ROLE_LABEL[role]}: {a.name}{#if !a.link} <em class="muted">(not in your data)</em>{/if}</span>
										{#if a.link}
											<button type="button" class="btn ghost sm" onclick={() => useArtists(role, [a])}>Use</button>
										{:else}
											<button type="button" class="btn ghost sm" onclick={() => createAndUse(role, a)}>Create &amp; use</button>
										{/if}
									</li>
								{/each}
							{/each}
							{#if s.durationMs}<li><span>Duration: {fmtClock(s.durationMs)}</span><button type="button" class="btn ghost sm" onclick={() => (duration = fmtClock(s.durationMs))}>Use</button></li>{/if}
							{#if s.date}<li><span>Released: {s.date}</span><button type="button" class="btn ghost sm" onclick={() => ((f.date = s.date), (f.dateKind = 'release'))}>Use</button></li>{/if}
							{#if s.label}<li><span>Label: {s.label}</span><button type="button" class="btn ghost sm" onclick={() => (f.label = s.label)}>Use</button></li>{/if}
							{#if s.coverUrl}<li><span>Cover from {SRC_LABEL[s.source]}</span><button type="button" class="btn ghost sm" onclick={() => (f.coverUrl = s.coverUrl)}>Use</button></li>{/if}
						</ul>
					</div>
				{/each}
			</div>
		{/if}
	</fieldset>

	<fieldset>
		<legend>Track</legend>
		<label for="ot-title">Title <span class="req">required</span></label>
		<input id="ot-title" bind:value={f.title} required maxlength="200" aria-invalid={!!errors.title} data-testid="ot-title" />
		{#if errors.title}<p class="err" data-testid="err-title">{errors.title}</p>{/if}
		<ArtistPicker id="primary" label="Artist(s) · required" bind:value={f.artists.primary} error={errors.artists ?? null} />
		{#each OTHER_ROLES as role (role)}
			<ArtistPicker id={role} label="{ROLE_LABEL[role]} · optional" bind:value={f.artists[role]} />
		{/each}
		<label for="ot-version">Version <span class="opt">optional</span></label>
		<input id="ot-version" list="ot-versions" bind:value={f.version} maxlength="100" placeholder="Extended Mix, Radio Edit, …" aria-invalid={!!errors.version} />
		<datalist id="ot-versions">{#each VERSIONS as v (v)}<option value={v}></option>{/each}</datalist>
		{#if errors.version}<p class="err">{errors.version}</p>{/if}
		<span class="lbl" id="ot-status-l">Status <span class="req">required</span></span>
		<div class="seg" role="radiogroup" aria-labelledby="ot-status-l" aria-invalid={!!errors.status}>
			{#each OWN_STATUS as s (s)}
				<label class="chip" class:on={f.status === s}><input type="radio" name="status" value={s} bind:group={f.status} class="sr" />{STATUS_LABEL[s]}</label>
			{/each}
		</div>
		{#if errors.status}<p class="err" data-testid="err-status">{errors.status}</p>{/if}
		<label for="ot-duration">Duration <span class="req">required</span></label>
		<input id="ot-duration" bind:value={duration} placeholder="m:ss" inputmode="numeric" aria-invalid={!!errors.duration} data-testid="ot-duration" />
		{#if durationHint}<p class="cap muted" data-testid="duration-hint">{durationHint}</p>{/if}
		{#if errors.duration}<p class="err" data-testid="err-duration">{errors.duration}</p>{/if}
	</fieldset>

	{#if dupes.length}
		<div class="dupes" role="alert" data-testid="duplicates">
			<p><b>Possible duplicate{dupes.length === 1 ? '' : 's'}</b></p>
			<ul>
				{#each dupes as d (d.kind + d.id)}
					<li><a href={d.href} target="_blank" rel="noopener">{d.title}</a> · {d.artist} · {d.kind === 'own' ? 'your own track' : 'in your history'}{d.strength === 'exact' ? ' · exact match' : ''}</li>
				{/each}
			</ul>
			<label class="cap"><input type="checkbox" bind:checked={confirmDupe} data-testid="confirm-dupe" /> It’s a different track: save anyway</label>
		</div>
	{/if}

	<fieldset>
		<legend>More <span class="opt">optional</span></legend>
		<label for="ot-label">Label</label>
		<input id="ot-label" bind:value={f.label} maxlength="200" aria-invalid={!!errors.label} />
		{#if errors.label}<p class="err">{errors.label}</p>{/if}
		<div class="row2">
			<div>
				<label for="ot-datekind">Date</label>
				<select id="ot-datekind" bind:value={f.dateKind}>
					<option value={null}>—</option>
					<option value="release">Release date</option>
					<option value="first_heard">First heard</option>
				</select>
			</div>
			<div>
				<label for="ot-date" class="sr">Date value</label>
				<input id="ot-date" type="date" bind:value={f.date} aria-invalid={!!errors.date} />
			</div>
		</div>
		{#if errors.date}<p class="err">{errors.date}</p>{/if}
		<div class="row2">
			<div>
				<label for="ot-heard">Heard it in (set)</label>
				<select id="ot-heard" bind:value={f.heardSetId}>
					<option value={null}>—</option>
					{#each sets as s (s.id)}<option value={s.id}>{s.title}</option>{/each}
				</select>
			</div>
			<div>
				<label for="ot-heardat">at</label>
				<input id="ot-heardat" bind:value={heardAt} placeholder="h:mm:ss" aria-invalid={!!errors.heard} />
			</div>
		</div>
		<input aria-label="Where you heard it (note)" bind:value={f.heardNote} maxlength="300" placeholder="Or a note: club, radio show, …" />
		{#if errors.heard}<p class="err">{errors.heard}</p>{/if}
		<label for="ot-cover">Cover link</label>
		<input id="ot-cover" type="url" bind:value={f.coverUrl} placeholder="https://…" aria-invalid={!!errors.cover} />
		<Uploader
			purpose="cover"
			{limits}
			label="Or upload a cover"
			current={coverMeta}
			onready={(r) => {
				f.coverObjectId = r.id;
				coverMeta = { id: r.id, name: r.name, size: r.size };
			}}
			onremove={() => {
				f.coverObjectId = null;
				coverMeta = null;
			}}
		/>
		{#if errors.cover}<p class="err">{errors.cover}</p>{/if}
		<label for="ot-notes">Notes</label>
		<textarea id="ot-notes" bind:value={f.notes} maxlength="4000" rows="3"></textarea>
	</fieldset>

	{#if touched && Object.keys(errors).length}
		<p class="err" role="alert" data-testid="form-errors">Fix {Object.keys(errors).length} field{Object.keys(errors).length === 1 ? '' : 's'} first.</p>
	{/if}
	<div class="acts">
		<button class="btn pri" type="submit" disabled={saving} data-testid="ot-save">{saving ? 'Saving…' : track ? 'Save' : 'Add track'}</button>
		<a class="btn ghost" href={track ? `/own/${track.id}` : '/library?source=own'}>Cancel</a>
	</div>
	<p class="cap muted">Own tracks live in Rotor only: they never go into a Spotify playlist.</p>
</form>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 720px;
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 12px 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		min-width: 0;
	}
	legend {
		font-weight: 800;
		padding: 0 6px;
	}
	label,
	.lbl {
		font-weight: 600;
		font-size: 14px;
	}
	.req,
	.opt {
		font-weight: 400;
		font-size: 12px;
		color: var(--text-3);
	}
	input:not([type='radio']):not([type='checkbox']):not([type='file']),
	select,
	textarea {
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px 12px;
		font: inherit;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
	}
	[aria-invalid='true'] {
		border-color: var(--danger) !important;
	}
	.err {
		color: var(--danger);
		font-size: 13px;
		margin: 0;
	}
	.seg {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.seg .chip {
		cursor: pointer;
	}
	.row2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.row2 > div {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.sugs {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.sug {
		background: var(--surface-2);
		border-radius: 8px;
		padding: 8px 10px;
	}
	.sug ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.sug li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		padding: 2px 0;
	}
	.dupes {
		border: 1px solid var(--warning, #e3b341);
		border-radius: 12px;
		padding: 10px 14px;
	}
	.dupes ul {
		margin: 4px 0 8px;
		padding-left: 18px;
	}
	.acts {
		display: flex;
		gap: 8px;
	}
</style>
