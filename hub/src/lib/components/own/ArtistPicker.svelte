<script lang="ts">
	import { apiGet, apiPost, ApiFailure, describeFailure } from '$lib/player/api-client';
	import { isPlaceholder, type ArtistLink } from '$lib/shared/own';
	import Icon from '$lib/components/Icon.svelte';

	/**
	 * Link artists (v0.94): pick one from your data (Spotify history) or a Rotor artist, or create a new
	 * artist explicitly. Free text is never saved as an artist.
	 */
	let { label, value = $bindable([]), id, error = null, max = 10 }: { label: string; value: ArtistLink[]; id: string; error?: string | null; max?: number } = $props();

	type Opt = ArtistLink & { plays: number | null };
	let q = $state('');
	let opts = $state<Opt[]>([]);
	let open = $state(false);
	let busy = $state(false);
	let local = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function search() {
		clearTimeout(timer);
		const term = q.trim();
		if (!term) {
			opts = [];
			open = false;
			return;
		}
		timer = setTimeout(async () => {
			try {
				const r = await apiGet<{ artists: Opt[] }>(`/api/own/artists?q=${encodeURIComponent(term)}`);
				if (q.trim() === term) {
					opts = r.artists.filter((a) => !value.some((v) => v.kind === a.kind && v.id === a.id));
					open = true;
				}
			} catch {
				opts = [];
			}
		}, 180);
	}
	function add(a: ArtistLink) {
		if (value.length >= max) return;
		value = [...value, { kind: a.kind, id: a.id, name: a.name }];
		q = '';
		opts = [];
		open = false;
		local = null;
	}
	function remove(i: number) {
		value = value.filter((_, j) => j !== i);
	}
	const exact = $derived(opts.some((o) => o.name.toLowerCase() === q.trim().toLowerCase()));
	async function create() {
		const name = q.trim();
		if (!name || isPlaceholder(name)) {
			local = `“${name}” is a placeholder, not an artist`;
			return;
		}
		busy = true;
		local = null;
		try {
			add(await apiPost<ArtistLink>('/api/own/artists', { name }));
		} catch (e) {
			const ex = e instanceof ApiFailure ? (e.body.detail?.existing as ArtistLink | undefined) : undefined;
			if (ex) add(ex);
			else local = describeFailure(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="ap" data-testid="artists-{id}">
	<label class="lbl" for="ap-{id}">{label}</label>
	{#if value.length}
		<ul class="chips" aria-label="{label}: linked">
			{#each value as a, i (a.kind + a.id)}
				<li class="chip on" data-kind={a.kind}>
					{a.name}{#if a.kind === 'rotor'}<span class="cap muted"> · new in Rotor</span>{/if}
					<button type="button" aria-label="Remove {a.name}" onclick={() => remove(i)}><Icon name="close" size={14} /></button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if value.length < max}
		<input
			id="ap-{id}"
			type="search"
			bind:value={q}
			oninput={search}
			onkeydown={(e) => e.key === 'Escape' && (open = false)}
			placeholder="Search your artists…"
			autocomplete="off"
			aria-invalid={!!error}
			aria-describedby={error ? `ap-${id}-err` : undefined}
		/>
	{/if}
	{#if open && q.trim()}
		<ul class="opts" role="listbox" aria-label="Matching artists">
			{#each opts as o (o.kind + o.id)}
				<li role="option" aria-selected="false">
					<button type="button" onclick={() => add(o)}>
						<span class="ell">{o.name}</span>
						<span class="cap muted">{o.kind === 'spotify' ? `in your data · ${o.plays ?? 0} plays` : 'Rotor artist'}</span>
					</button>
				</li>
			{/each}
			{#if !exact}
				<li role="option" aria-selected="false">
					<button type="button" class="new" disabled={busy} onclick={create} data-testid="create-artist">
						<Icon name="plus" size={14} /> Create “{q.trim()}” as a new artist
					</button>
				</li>
			{/if}
		</ul>
	{/if}
	{#if error || local}<p class="err" id="ap-{id}-err" role="alert">{local ?? error}</p>{/if}
</div>

<style>
	.ap {
		display: flex;
		flex-direction: column;
		gap: 6px;
		position: relative;
	}
	.lbl {
		font-weight: 600;
		font-size: 14px;
	}
	.chips {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.chip button {
		background: none;
		border: 0;
		color: inherit;
		padding: 2px;
		cursor: pointer;
		display: grid;
	}
	input {
		background: var(--surface-2);
		color: var(--text-1);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px 12px;
		font: inherit;
	}
	input[aria-invalid='true'] {
		border-color: var(--danger, #e5534b);
	}
	.opts {
		list-style: none;
		margin: 0;
		padding: 4px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 8px;
		max-height: 260px;
		overflow: auto;
	}
	.opts button {
		width: 100%;
		display: flex;
		justify-content: space-between;
		gap: 8px;
		background: none;
		border: 0;
		color: var(--text-1);
		padding: 8px;
		border-radius: 6px;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.opts button:hover,
	.opts button:focus-visible {
		background: var(--surface-3);
	}
	.new {
		justify-content: flex-start !important;
		color: var(--accent) !important;
	}
	.err {
		color: var(--danger, #e5534b);
		font-size: 13px;
		margin: 0;
	}
</style>
