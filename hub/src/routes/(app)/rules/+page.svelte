<script lang="ts">
	import { onMount } from 'svelte';
	import Header from '$lib/components/Header.svelte';
	import { apiGet } from '$lib/player/api-client';
	import { fmtDate } from '$lib/shared/format';
	import type { RuleCategory } from '$lib/server/library';

	/**
	 * The 16 rule categories of lib/playlists.py, read-only. Texts are shown exactly as
	 * that module defines them (Dutch), the same source the Streamlit Rules page renders.
	 */
	interface RulesResponse {
		categories: RuleCategory[];
		playlists: Record<string, { id: string; name: string }[]>;
		exportedAt: string | null;
	}
	let data = $state<RulesResponse | null>(null);
	let failed = $state(false);
	onMount(() => {
		apiGet<RulesResponse>('/api/rules')
			.then((r) => (data = r))
			.catch(() => (failed = true));
	});
	const total = $derived(data ? data.categories.reduce((n, c) => n + c.playlistCount, 0) : 0);
	const noCron = $derived(data ? data.categories.filter((c) => !c.cron).length : 0);
</script>

<svelte:head><title>Rotor · Rules</title></svelte:head>

<div class="view">
	<Header title="Rules" />
	{#if failed}
		<p class="notice">Could not load the rules.</p>
	{:else if !data}
		{#each [1, 2, 3] as i (i)}<div class="skel" style="height:96px;margin-top:12px;border-radius:12px"></div>{/each}
	{:else if !data.categories.length}
		<p class="notice">No rules exported yet. They're copied from the cron code by the nightly playlist mirror (or run <code>uv run python scripts/sync_playlist_mirror.py</code>).</p>
	{:else}
		<div class="summary">
			<div><b class="tab-num" data-testid="rule-categories">{data.categories.length}</b><span class="cap">categories</span></div>
			<div><b class="tab-num" data-testid="rule-playlists">{total}</b><span class="cap">managed playlists</span></div>
			<div><b class="tab-num">{noCron}</b><span class="cap">without a cron</span></div>
		</div>
		<p class="cap muted">Exported from lib/playlists.py {fmtDate(data.exportedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Rule texts as written in the code.</p>
		{#each data.categories as c (c.key)}
			<section class="cat" id={c.key}>
				<div class="top">
					<h2>{c.name}</h2>
					<span class="badge">{c.kind === 'snapshot' ? 'Snapshot' : 'Auto'}</span>
					<span class="cap tab-num">{c.playlistCount} playlist{c.playlistCount === 1 ? '' : 's'}</span>
				</div>
				<p class="rule">{c.ruleNl}</p>
				<dl>
					<dt>Name</dt><dd><code>{c.nameForm}</code></dd>
					<dt>{c.scheduleKind === 'refresh' ? 'Refreshes' : 'Created'}</dt><dd>{c.scheduleNl}</dd>
					{#if c.nextCreationNl}<dt>Next</dt><dd>{c.nextCreationNl}</dd>{/if}
					{#if c.cronJob}<dt>Cron</dt><dd><code>{c.cron}</code> · {c.cronJob} · <code>{c.cronScript}</code></dd>{/if}
				</dl>
				{#if c.memberVariation}<p class="cap">{c.memberVariation}</p>{/if}
				{#if c.variants.length}
					<table>
						<thead><tr><th>Playlist</th><th>Differs by</th></tr></thead>
						<tbody>{#each c.variants as v (v.full_name)}<tr><td>{v.full_name}</td><td>{v.rule_param}</td></tr>{/each}</tbody>
					</table>
				{/if}
				{#if c.notes}<details><summary class="cap">Notes</summary><p class="cap">{c.notes}</p></details>{/if}
				{#if data.playlists[c.key]?.length}
					<details>
						<summary class="cap">Playlists in your library ({data.playlists[c.key]!.length})</summary>
						<ul>{#each data.playlists[c.key]! as p (p.id)}<li><a href="/playlist/{p.id}">{p.name}</a></li>{/each}</ul>
					</details>
				{/if}
				{#if c.querySources.length}
					<details>
						<summary class="cap">Query source</summary>
						{#each c.querySources as q (q.function)}<p class="cap muted">{q.function}</p><pre>{q.source || q.error}</pre>{/each}
					</details>
				{/if}
			</section>
		{/each}
	{/if}
</div>

<style>
	.summary {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
		margin: 4px 0 8px;
	}
	.summary div {
		background: var(--surface-2);
		border-radius: var(--r-card);
		padding: 12px;
		display: flex;
		flex-direction: column;
	}
	.summary b {
		font-size: 28px;
		line-height: 32px;
		font-weight: 800;
	}
	.cat {
		background: var(--surface-2);
		border-radius: 12px;
		padding: 14px;
		margin-top: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		scroll-margin-top: 80px;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 17px;
		font-weight: 800;
		flex: 1;
		min-width: 60%;
	}
	.rule {
		font-size: 14px;
		line-height: 20px;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 14px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		color: var(--text-3);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	code {
		font-size: 12px;
	}
	table {
		border-collapse: collapse;
		font-size: 13px;
		width: 100%;
	}
	th,
	td {
		text-align: left;
		padding: 4px 6px;
		border-bottom: 1px solid var(--border);
	}
	th {
		color: var(--text-3);
		font-weight: 700;
	}
	pre {
		white-space: pre-wrap;
		font-size: 11px;
		background: var(--bg);
		padding: 8px;
		border-radius: 6px;
		overflow-x: auto;
	}
	ul {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 13px;
	}
	li a {
		text-decoration: underline;
	}
</style>
