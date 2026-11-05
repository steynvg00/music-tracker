<script lang="ts">
	import Icon from '../Icon.svelte';
	import Sheet from '../Sheet.svelte';
	import { customSheet as s } from './store.svelte';
	import { SORT_LABEL, SORT_ORDERS, MAX_NAME, type SortOrder } from '$lib/shared/custom';
	import { MANAGED_SUFFIXES } from '$lib/shared/managed';
	import { fmtInt } from '$lib/shared/format';

	/** New / Edit custom playlist: 1 Filters (live count) → 2 Preview (remove tracks) → 3 Save. */
	let q = $state('');
	let suggestions = $state<{ name: string; plays: number }[]>([]);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function onSearch(v: string) {
		q = v;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(async () => {
			suggestions = await s.searchArtists(v).catch(() => []);
		}, 250);
	}
	function addArtist(name: string) {
		if (!s.filters.artists.includes(name)) s.update({ artists: [...s.filters.artists, name] });
		q = '';
		suggestions = [];
	}
	function num(v: string): number | null {
		const n = parseInt(v, 10);
		return Number.isFinite(n) ? n : null;
	}
	const title = $derived(s.mode === 'create' ? 'New custom playlist' : `Edit ${s.editName}`);
	const steps = ['Filters', 'Preview', s.mode === 'create' ? 'Save' : 'Update'];
</script>

<Sheet open={s.open} onclose={() => s.close()} label={title} wide>
	<div class="head">
		<h3 class="ell">{title}</h3>
		<button class="ibtn" aria-label="Close" onclick={() => s.close()}><Icon name="close" size={18} /></button>
	</div>
	<ol class="steps" aria-label="Steps">
		{#each steps as label, i (label)}
			<li class:on={s.step === i + 1}><button disabled={i + 1 > 1 && s.count === 0} onclick={() => (s.step = (i + 1) as 1 | 2 | 3)}>{i + 1} · {label}</button></li>
		{/each}
	</ol>

	{#if s.step === 1}
		{#if s.noStoredFilters}<p class="notice">This playlist was made before Rotor stored filters. Pick new filters; saving replaces its tracks.</p>{/if}
		<div class="field">
			<label for="cp-artist">Artists <span class="muted">(any of them)</span></label>
			<div class="chips">
				{#each s.filters.artists as a (a)}
					<button class="chip on" onclick={() => s.update({ artists: s.filters.artists.filter((x) => x !== a) })} aria-label="Remove {a}">{a} ×</button>
				{/each}
			</div>
			<input id="cp-artist" class="input" placeholder="Search your artists…" value={q} oninput={(e) => onSearch(e.currentTarget.value)} autocomplete="off" />
			{#if suggestions.length}
				<div class="sugg" role="listbox" aria-label="Artist suggestions">
					{#each suggestions as a (a.name)}
						<button role="option" aria-selected="false" onclick={() => addArtist(a.name)}>{a.name} <span class="muted">{fmtInt(a.plays)} plays</span></button>
					{/each}
				</div>
			{/if}
		</div>
		<div class="grid">
			<div class="field">
				<label for="cp-rel-from">Released</label>
				<div class="range">
					<input id="cp-rel-from" class="input" inputmode="numeric" placeholder="from" value={s.filters.release_year_min ?? ''} onchange={(e) => s.update({ release_year_min: num(e.currentTarget.value) })} />
					<input class="input" inputmode="numeric" placeholder="to" aria-label="Released to" value={s.filters.release_year_max ?? ''} onchange={(e) => s.update({ release_year_max: num(e.currentTarget.value) })} />
				</div>
			</div>
			<div class="field">
				<label for="cp-disc-from">Discovered</label>
				<div class="range">
					<input id="cp-disc-from" class="input" inputmode="numeric" placeholder="from" value={s.filters.discovery_year_min ?? ''} onchange={(e) => s.update({ discovery_year_min: num(e.currentTarget.value) })} />
					<input class="input" inputmode="numeric" placeholder="to" aria-label="Discovered to" value={s.filters.discovery_year_max ?? ''} onchange={(e) => s.update({ discovery_year_max: num(e.currentTarget.value) })} />
				</div>
			</div>
			<div class="field">
				<label for="cp-min">Min plays</label>
				<input id="cp-min" class="input" inputmode="numeric" value={s.filters.min_plays ?? ''} onchange={(e) => s.update({ min_plays: num(e.currentTarget.value) })} />
			</div>
			<div class="field">
				<label for="cp-max">Max tracks</label>
				<input id="cp-max" class="input" inputmode="numeric" value={s.filters.max_tracks} onchange={(e) => s.update({ max_tracks: num(e.currentTarget.value) ?? 100 })} />
			</div>
			<div class="field">
				<label for="cp-sort">Sort</label>
				<select id="cp-sort" class="input" value={s.filters.sort_order} onchange={(e) => s.update({ sort_order: e.currentTarget.value as SortOrder })}>
					{#each SORT_ORDERS as o (o)}<option value={o}>{SORT_LABEL[o]}</option>{/each}
				</select>
			</div>
			<label class="check"><input type="checkbox" checked={s.filters.liked_only} onchange={(e) => s.update({ liked_only: e.currentTarget.checked })} /> Liked only</label>
		</div>
		<div class="count" aria-live="polite">
			{#if s.loading}<span class="spin"></span>{/if}
			{#if s.error}<span class="err">{s.error}</span>
			{:else if s.count !== null}<b class="tab-num" data-testid="match-count">{fmtInt(s.count)}</b>&nbsp;tracks match{#if s.count > s.filters.max_tracks}&nbsp;· the playlist takes the first {s.filters.max_tracks}{/if}{/if}
		</div>
		<div class="foot"><button class="btn pri" disabled={!s.count} onclick={() => (s.step = 2)}>Preview</button></div>
	{:else if s.step === 2}
		<p class="cap">{s.kept.length} of {s.tracks.length} tracks · tap × to leave one out{#if s.excluded.length}&nbsp;· <button class="link" onclick={() => (s.excluded = [])}>restore all</button>{/if}</p>
		<div class="plist">
			{#each s.tracks as t, i (t.uri)}
				{@const out = s.excluded.includes(t.uri)}
				<div class="prow" class:out>
					<span class="idx tab-num">{i + 1}</span>
					<span class="grow"><span class="ell rt">{t.name ?? t.uri}</span><span class="ell rm">{t.artist ?? ''} · {fmtInt(t.plays)} plays</span></span>
					<button class="ibtn" aria-label="{out ? 'Keep' : 'Leave out'} {t.name}" onclick={() => s.toggle(t.uri)}><Icon name={out ? 'plus' : 'close'} size={16} /></button>
				</div>
			{/each}
		</div>
		<div class="foot"><button class="btn ghost" onclick={() => (s.step = 1)}>Back</button><button class="btn pri" disabled={!s.kept.length} onclick={() => (s.step = 3)}>Next</button></div>
	{:else}
		{#if s.mode === 'create'}
			<div class="field">
				<label for="cp-name">Name</label>
				<div class="nameline">
					<input id="cp-name" class="input" maxlength={MAX_NAME} placeholder="Late night hardstyle" bind:value={s.name} />
					<span class="tail" aria-label="Suffix added by Rotor">{MANAGED_SUFFIXES.custom}</span>
				</div>
			</div>
			<div class="field">
				<span class="lbl">Lifetime</span>
				<div class="chips">
					{#each [['7d', '7 days'], ['30d', '30 days'], ['keep', 'Keep']] as const as [v, l] (v)}
						<button class="chip" class:on={s.lifetime === v} aria-pressed={s.lifetime === v} onclick={() => (s.lifetime = v)}>{l}</button>
					{/each}
				</div>
			</div>
			<p class="cap">{s.kept.length} tracks · private playlist in your Spotify library{s.lifetime === 'keep' ? '' : ', deleted automatically after the lifetime'}.</p>
		{:else}
			<p class="cap">Replaces the tracks of <b>{s.editName}</b> on Spotify with these {s.kept.length}.</p>
		{/if}
		{#if s.error}<p class="err">{s.error}</p>{/if}
		<div class="foot">
			<button class="btn ghost" onclick={() => (s.step = 2)}>Back</button>
			<button class="btn pri" disabled={s.saving || (s.mode === 'create' && !s.name.trim())} onclick={() => s.save()}>
				{#if s.saving}<span class="spin"></span>{/if}{s.mode === 'create' ? 'Create' : 'Update on Spotify'}
			</button>
		</div>
	{/if}
</Sheet>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	h3 {
		font-size: 18px;
		font-weight: 800;
	}
	.steps {
		display: flex;
		gap: 6px;
		list-style: none;
		padding: 0;
		margin: 6px 0 12px;
	}
	.steps button {
		font-size: 12px;
		font-weight: 700;
		color: var(--text-3);
		padding: 4px 10px;
		border-radius: var(--r-pill);
	}
	.steps li.on button {
		color: var(--text-1);
		background: var(--surface-4);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 12px;
	}
	label,
	.lbl {
		font-size: 12px;
		font-weight: 700;
		color: var(--text-2);
	}
	.input {
		height: 40px;
		border-radius: var(--r-card);
		border: 1px solid var(--border);
		background: var(--surface-3);
		color: var(--text-1);
		padding: 0 12px;
		font: inherit;
		width: 100%;
		min-width: 0;
	}
	.input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 12px;
		align-items: end;
	}
	.range {
		display: flex;
		gap: 6px;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		margin-bottom: 12px;
		color: var(--text-1);
		font-size: 14px;
	}
	.check input {
		width: 18px;
		height: 18px;
		accent-color: var(--accent);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		height: 32px;
		padding: 0 14px;
		border-radius: var(--r-pill);
		background: var(--surface-3);
		font-size: 13px;
		font-weight: 650;
		border: 1px solid transparent;
	}
	.chip.on {
		background: var(--accent-subtle);
		border-color: var(--accent);
	}
	.sugg {
		display: flex;
		flex-direction: column;
		background: var(--surface-3);
		border-radius: var(--r-card);
		overflow: hidden;
	}
	.sugg button {
		text-align: left;
		padding: 10px 12px;
		font-size: 14px;
	}
	.sugg button:hover {
		background: var(--surface-4);
	}
	.count {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px;
		border-radius: var(--r-card);
		background: var(--surface-3);
		font-size: 14px;
		min-height: 44px;
	}
	.count b {
		color: var(--text-1);
		font-size: 18px;
	}
	.err {
		color: var(--danger);
		font-size: 13px;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 14px;
	}
	.plist {
		max-height: 46vh;
		overflow-y: auto;
		margin: 6px -4px 0;
	}
	.prow {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 2px 4px;
		min-height: 48px;
	}
	.prow.out {
		opacity: 0.4;
	}
	.prow.out .rt {
		text-decoration: line-through;
	}
	.idx {
		width: 24px;
		color: var(--text-3);
		font-size: 12px;
		text-align: right;
	}
	.grow {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.rt {
		font-weight: 650;
		font-size: 14px;
	}
	.rm {
		font-size: 12px;
		color: var(--text-3);
	}
	.nameline {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tail {
		color: var(--text-3);
		white-space: nowrap;
		font-size: 14px;
	}
	.link {
		color: var(--accent-hover);
		font-weight: 700;
	}
	.notice {
		margin: 0 0 12px;
	}
</style>
