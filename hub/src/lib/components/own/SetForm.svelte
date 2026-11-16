<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import ArtistPicker from './ArtistPicker.svelte';
	import Uploader from './Uploader.svelte';
	import EmbedPlayer from './EmbedPlayer.svelte';
	import { ApiFailure, apiGet, apiPost, apiPut, describeFailure } from '$lib/player/api-client';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { displayTitle, fmtClock, parseDuration, soundcloudUrl, youtubeId, type ArtistLink, type OwnTrack } from '$lib/shared/own';
	import { validateSet, type DjSet, type EntryKind, type ParsedLine, type SetErrors, type SetSource } from '$lib/shared/sets';
	import type { StorageLimits } from '$lib/shared/media';

	/** Add / edit a DJ or live set (v0.94). One source; optional tracklist (paste + parse, you confirm links). */
	let { set = null }: { set?: DjSet | null } = $props();

	interface Row {
		start: string;
		kind: EntryKind;
		trackUri: string | null;
		ownTrackId: string | null;
		artist: string;
		title: string;
		suggestion: { kind: EntryKind; trackUri: string | null; ownTrackId: string | null; artist: string | null; title: string; label: string } | null;
	}
	const s0 = untrack(() => set);
	let title = $state(s0?.title ?? '');
	let artists = $state<ArtistLink[]>(s0 ? [...s0.artists] : []);
	let event = $state(s0?.event ?? '');
	let date = $state(s0?.date ?? '');
	let duration = $state(s0 ? fmtClock(s0.durationMs) : '');
	let coverUrl = $state(s0?.coverUrl ?? '');
	let coverObjectId = $state<string | null>(s0?.coverObjectId ?? null);
	let source = $state<SetSource>(s0?.source ?? 'youtube');
	let ytUrl = $state(s0?.youtubeId ? `https://www.youtube.com/watch?v=${s0.youtubeId}` : '');
	let scUrl = $state(s0?.soundcloudUrl ?? '');
	let audioObjectId = $state<string | null>(s0?.audio?.id ?? null);
	let audioMeta = $state(s0?.audio ? { id: s0.audio.id, name: s0.audio.name, size: s0.audio.size } : null);
	let rows = $state<Row[]>(
		(s0?.tracklist ?? []).map((t) => ({ start: t.startMs === null ? '' : fmtClock(t.startMs), kind: t.kind, trackUri: t.trackUri, ownTrackId: t.ownTrackId, artist: t.artist ?? '', title: t.title, suggestion: null }))
	);
	let paste = $state('');
	let errors = $state<SetErrors>({});
	let touched = $state(false);
	let saving = $state(false);
	let limits = $state<StorageLimits | null>(null);
	let own = $state<OwnTrack[]>([]);
	let hint = $state<string | null>(null);

	onMount(async () => {
		const [st, o] = await Promise.allSettled([apiGet<{ configured: boolean; limits: StorageLimits }>('/api/media/storage'), apiGet<{ tracks: OwnTrack[] }>('/api/own')]);
		if (st.status === 'fulfilled' && st.value.configured) limits = st.value.limits;
		if (o.status === 'fulfilled') own = o.value.tracks;
	});

	const body = () => ({
		title,
		artists,
		event,
		date: date || null,
		durationMs: parseDuration(duration),
		coverUrl: coverUrl || null,
		coverObjectId,
		youtubeUrl: source === 'youtube' ? ytUrl : null,
		soundcloudUrl: source === 'soundcloud' ? scUrl : null,
		audioObjectId: source === 'upload' ? audioObjectId : null,
		tracklist: rows.map((r) => ({ startMs: r.start.trim() || null, kind: r.kind, trackUri: r.trackUri, ownTrackId: r.ownTrackId, artist: r.artist || null, title: r.title }))
	});
	$effect(() => {
		const b = body();
		if (!touched) return;
		const v = validateSet(b);
		errors = v.ok ? {} : v.errors;
	});
	const yt = $derived(source === 'youtube' ? youtubeId(ytUrl) : null);
	const sc = $derived(source === 'soundcloud' ? soundcloudUrl(scUrl) : null);
	function setDuration(ms: number | null, from: string) {
		if (!ms) return;
		if (!duration.trim()) duration = fmtClock(ms);
		hint = `${from}: ${fmtClock(ms)}`;
	}

	let parsing = $state(false);
	async function parse() {
		parsing = true;
		try {
			const r = await apiPost<{ lines: ParsedLine[]; matches: { line: number; suggestion: Row['suggestion'] }[] }>('/api/sets/match', { text: paste });
			const byLine = new Map(r.matches.map((m) => [m.line, m.suggestion]));
			rows = [
				...rows,
				...r.lines.map((l) => ({
					start: l.startMs === null ? '' : fmtClock(l.startMs),
					kind: 'id' as EntryKind,
					trackUri: null,
					ownTrackId: null,
					artist: l.artist ?? '',
					title: l.isId ? 'ID' : l.title,
					suggestion: byLine.get(l.line) ?? null
				}))
			];
			toasts.show(`${r.lines.length} entries read · ${r.matches.filter((m) => m.suggestion).length} with a suggested link`);
			paste = '';
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			parsing = false;
		}
	}
	function link(r: Row) {
		const s = r.suggestion;
		if (!s) return;
		r.kind = s.kind;
		r.trackUri = s.trackUri;
		r.ownTrackId = s.ownTrackId;
		r.artist = s.artist ?? r.artist;
		r.title = s.title;
	}
	function linkOwn(r: Row, id: string) {
		const t = own.find((x) => x.id === id);
		if (!t) return;
		r.kind = 'own';
		r.ownTrackId = t.id;
		r.trackUri = null;
		r.artist = t.artists.primary.map((a) => a.name).join(', ');
		r.title = displayTitle(t);
	}
	function unlink(r: Row) {
		r.kind = 'id';
		r.trackUri = null;
		r.ownTrackId = null;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		touched = true;
		const b = body();
		const v = validateSet(b);
		if (!v.ok) {
			errors = v.errors;
			return;
		}
		saving = true;
		try {
			const r = set ? await apiPut<DjSet>(`/api/sets/${set.id}`, b) : await apiPost<DjSet>('/api/sets', b);
			toasts.show(set ? 'Saved' : `Added “${r.title}”`);
			await goto(`/sets/${r.id}`);
		} catch (err) {
			if (err instanceof ApiFailure && err.body.fields) errors = err.body.fields as SetErrors;
			else toasts.error(describeFailure(err));
		} finally {
			saving = false;
		}
	}
	const KIND_LABEL: Record<EntryKind, string> = { catalog: 'Catalog', own: 'Own', id: 'ID' };
</script>

<form class="form" onsubmit={save} novalidate data-testid="set-form">
	<fieldset>
		<legend>Set</legend>
		<label for="st-title">Title <span class="req">required</span></label>
		<input id="st-title" bind:value={title} maxlength="200" aria-invalid={!!errors.title} data-testid="st-title" />
		{#if errors.title}<p class="err">{errors.title}</p>{/if}
		<ArtistPicker id="djs" label="DJ(s) / artist(s) · required" bind:value={artists} error={errors.artists ?? null} />
		<label for="st-event">Event <span class="opt">optional</span></label>
		<input id="st-event" bind:value={event} maxlength="200" aria-invalid={!!errors.event} />
		<label for="st-date">Date <span class="opt">optional</span></label>
		<input id="st-date" type="date" bind:value={date} />
		<label for="st-duration">Duration <span class="req">required</span></label>
		<input id="st-duration" bind:value={duration} placeholder="h:mm:ss" aria-invalid={!!errors.duration} data-testid="st-duration" />
		{#if hint}<p class="cap muted">{hint}</p>{/if}
		{#if errors.duration}<p class="err">{errors.duration}</p>{/if}
	</fieldset>

	<fieldset>
		<legend>Source <span class="req">one</span></legend>
		<div class="seg" role="radiogroup" aria-label="Source">
			{#each [['youtube', 'YouTube'], ['soundcloud', 'SoundCloud'], ['upload', 'Upload']] as [k, l] (k)}
				<label class="chip" class:on={source === k}><input class="sr" type="radio" name="src" value={k} bind:group={source} />{l}</label>
			{/each}
		</div>
		{#if source === 'youtube'}
			<input aria-label="YouTube link" type="url" bind:value={ytUrl} placeholder="https://www.youtube.com/watch?v=…" aria-invalid={!!errors.source} data-testid="st-yt" />
		{:else if source === 'soundcloud'}
			<input aria-label="SoundCloud link" type="url" bind:value={scUrl} placeholder="https://soundcloud.com/…" aria-invalid={!!errors.source} />
		{:else}
			<Uploader
				purpose="set"
				{limits}
				label="Set audio file"
				current={audioMeta}
				onready={(r) => {
					audioObjectId = r.id;
					audioMeta = { id: r.id, name: r.name, size: r.size };
					setDuration(r.durationMs, 'Read from the file');
				}}
				onremove={() => {
					audioObjectId = null;
					audioMeta = null;
				}}
			/>
		{/if}
		{#if errors.source}<p class="err" role="alert">{errors.source}</p>{/if}
		{#if yt || sc}<EmbedPlayer youtubeId={yt} soundcloudUrl={sc} title={title || 'Preview'} onduration={(ms) => setDuration(ms, yt ? 'YouTube' : 'SoundCloud')} />{/if}
		<label for="st-cover">Cover link <span class="opt">optional</span></label>
		<input id="st-cover" type="url" bind:value={coverUrl} placeholder="https://…" aria-invalid={!!errors.cover} />
		<Uploader purpose="cover" {limits} label="Or upload a cover" current={coverObjectId ? { id: coverObjectId, name: 'Cover', size: 0 } : null} onready={(r) => (coverObjectId = r.id)} onremove={() => (coverObjectId = null)} />
	</fieldset>

	<fieldset>
		<legend>Tracklist <span class="opt">optional</span></legend>
		<label for="st-paste">Paste a tracklist (“00:00 Artist - Title”, one per line)</label>
		<textarea id="st-paste" rows="5" bind:value={paste} placeholder={'00:00 Artist - Title\n03:45 Artist - Title (Extended Mix)\n07:10 ID - ID'} data-testid="st-paste"></textarea>
		<button type="button" class="btn sec sm" disabled={!paste.trim() || parsing} onclick={parse} data-testid="st-parse">{parsing ? 'Reading…' : 'Read tracklist'}</button>
		{#if rows.length}
			<ol class="tl" data-testid="st-rows">
				{#each rows as r, i (i)}
					<li data-kind={r.kind}>
						<input class="ts" aria-label="Start of entry {i + 1}" bind:value={r.start} placeholder="m:ss" />
						<span class="k badge" class:id={r.kind === 'id'}>{KIND_LABEL[r.kind]}</span>
						<input aria-label="Artist of entry {i + 1}" bind:value={r.artist} placeholder="Artist" disabled={r.kind !== 'id'} />
						<input aria-label="Title of entry {i + 1}" bind:value={r.title} placeholder="Title" disabled={r.kind !== 'id'} />
						<span class="links">
							{#if r.kind === 'id' && r.suggestion}
								<button type="button" class="btn ghost sm" onclick={() => link(r)} title={r.suggestion.label} data-testid="st-link">Link: {r.suggestion.title}</button>
							{/if}
							{#if r.kind === 'id' && own.length}
								<select aria-label="Link entry {i + 1} to an own track" onchange={(e) => linkOwn(r, (e.target as HTMLSelectElement).value)}>
									<option value="">Own track…</option>
									{#each own as t (t.id)}<option value={t.id}>{displayTitle(t)}</option>{/each}
								</select>
							{/if}
							{#if r.kind !== 'id'}<button type="button" class="btn ghost sm" onclick={() => unlink(r)}>Unlink</button>{/if}
							<button type="button" class="ibtn" aria-label="Remove entry {i + 1}" onclick={() => (rows = rows.filter((_, j) => j !== i))}>×</button>
						</span>
					</li>
				{/each}
			</ol>
		{/if}
		<button type="button" class="btn ghost sm" onclick={() => (rows = [...rows, { start: '', kind: 'id', trackUri: null, ownTrackId: null, artist: '', title: 'ID', suggestion: null }])}>Add entry</button>
		{#if errors.tracklist}<p class="err" role="alert">{errors.tracklist}</p>{/if}
		<p class="cap muted">Unlinked entries are kept as free text, marked “ID”.</p>
	</fieldset>

	<div class="acts">
		<button class="btn pri" type="submit" disabled={saving} data-testid="st-save">{saving ? 'Saving…' : set ? 'Save' : 'Add set'}</button>
		<a class="btn ghost" href={set ? `/sets/${set.id}` : '/sets'}>Cancel</a>
	</div>
</form>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 820px;
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
	label {
		font-weight: 600;
		font-size: 14px;
	}
	.req,
	.opt {
		font-weight: 400;
		font-size: 12px;
		color: var(--text-3);
	}
	input:not([type='radio']):not([type='file']),
	select,
	textarea {
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		font: inherit;
		min-width: 0;
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
		gap: 6px;
	}
	.tl {
		margin: 0;
		padding: 0 0 0 22px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.tl li {
		display: grid;
		grid-template-columns: 72px auto 1fr 1fr;
		gap: 6px;
		align-items: center;
	}
	.tl .links {
		grid-column: 1 / -1;
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
	}
	.k.id {
		opacity: 0.7;
	}
	.acts {
		display: flex;
		gap: 8px;
	}
	@media (max-width: 600px) {
		.tl li {
			grid-template-columns: 64px auto 1fr;
		}
		.tl li input:last-of-type {
			grid-column: 1 / -1;
		}
	}
</style>
