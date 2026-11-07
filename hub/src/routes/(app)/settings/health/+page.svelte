<script lang="ts">
	import Header from '$lib/components/Header.svelte';
	import StatsError from '$lib/components/stats/StatsError.svelte';
	import { fmtDate, fmtInt } from '$lib/shared/format';
	import { ago, fmtBytes, TONE_COLOR, type DataHealth, type Tone } from '$lib/shared/health';

	let { data } = $props();
	const h = $derived(data.r.data as DataHealth | null);
	const now = $derived(h ? new Date(h.generatedAt) : new Date());
	const dt = (s: string | null) => (s ? fmtDate(s, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
	const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
	const TONE_LABEL: Record<Tone, string> = { ok: 'OK', warn: 'Late', danger: 'Problem', info: 'Info' };
	const STATE_LABEL: Record<string, string> = {
		active: 'active',
		disabled_inactivity: 'disabled (60 days without activity)',
		disabled_manually: 'disabled by hand',
		disabled_fork: 'disabled (fork)'
	};
	const radarName = { spotify: 'Spotify', musicbrainz: 'MusicBrainz', scantraxx: 'Scantraxx' } as const;
</script>

<svelte:head><title>Rotor · Data health</title></svelte:head>

{#snippet dot(t: Tone)}<span class="dot" style="background:{TONE_COLOR[t]}" title={TONE_LABEL[t]} aria-label={TONE_LABEL[t]} role="img"></span>{/snippet}

<div class="view">
	<Header title="Data health" />
	<p class="cap"><a href="/settings">‹ Settings</a></p>
	{#if !h}
		<StatsError r={data.r} />
	{:else}
		<section class="section" aria-labelledby="h-ingest">
			<div class="sec-h"><h2 id="h-ingest">Last ingest per source</h2></div>
			<ul class="rows" data-testid="health-ingest">
				{#each h.ingest as s (s.key)}
					<li data-key={s.key} data-tone={s.tone}>
						{@render dot(s.tone)}
						<span class="l"><b>{s.label}</b>{#if s.newestAt}<span class="cap muted"> · newest play {ago(s.newestAt, now)}</span>{/if}{#if s.detail}<span class="cap muted"> · {s.detail}</span>{/if}</span>
						<span class="v tab-num" title={dt(s.lastAt)}>{ago(s.lastAt, now)}</span>
					</li>
				{/each}
			</ul>
		</section>

		<section class="section" aria-labelledby="h-cron">
			<div class="sec-h"><h2 id="h-cron">Crons (GitHub Actions)</h2></div>
			{#if !h.cron.known}
				<p class="cap" data-testid="cron-unknown"><b>Unknown.</b> {h.cron.reason}</p>
			{:else}
				{#if h.cron.repoPrivate}
					<p class="cap">{h.cron.reason}</p>
				{:else if h.cron.autoDisableAt}
					<p class="cap" data-testid="cron-autodisable" style="color:{h.cron.daysLeft !== null && h.cron.daysLeft < 21 ? TONE_COLOR[h.cron.daysLeft < 7 ? 'danger' : 'warn'] : 'inherit'}">
						Scheduled workflows auto-disable ≈ <b>{fmtDate(h.cron.autoDisableAt)}</b> ({h.cron.daysLeft} days) unless there's activity first. Keepalive resets this every Monday.
					</p>
					<p class="cap muted">Last push {ago(h.cron.lastPushAt, now)} · last successful keepalive {ago(h.cron.lastKeepaliveAt, now)}.</p>
				{/if}
			{/if}
			<ul class="rows" data-testid="health-cron">
				{#each h.cron.workflows as w (w.file)}
					<li data-file={w.file} data-tone={w.tone}>
						{@render dot(w.tone)}
						<span class="l">
							<b>{w.name}</b> <span class="cap muted">{w.file} · {w.schedule}</span>
							<span class="cap">
								{w.state ? (STATE_LABEL[w.state] ?? w.state) : 'state unknown'}
								{#if w.lastRunAt}
									· last run {ago(w.lastRunAt, now)} ({w.lastEvent ?? 'run'}, {w.lastConclusion ?? 'running'}){#if w.lastRunUrl}
										· <a href={w.lastRunUrl} target="_blank" rel="noopener noreferrer">open run</a>{/if}
								{/if}
								· auto-disable {w.autoDisableAt ? `≈ ${fmtDate(w.autoDisableAt)}` : 'unknown'}
							</span>
						</span>
					</li>
				{/each}
			</ul>
		</section>

		<section class="section" aria-labelledby="h-enrich">
			<div class="sec-h"><h2 id="h-enrich">Enrichment</h2></div>
			<dl data-testid="health-enrichment">
				<dt>Tracks you've played</dt><dd class="tab-num">{fmtInt(h.enrichment.tracks)}</dd>
				<dt>With track metadata</dt><dd class="tab-num">{fmtInt(h.enrichment.enriched)} · {pct(h.enrichment.enriched, h.enrichment.tracks)} {#if h.enrichment.tracks - h.enrichment.enriched > 0}<span class="muted">({fmtInt(h.enrichment.tracks - h.enrichment.enriched)} not enriched)</span>{/if}</dd>
				<dt>With duration</dt><dd class="tab-num">{fmtInt(h.enrichment.withDuration)} · {pct(h.enrichment.withDuration, h.enrichment.tracks)}</dd>
				<dt>With artist ids</dt><dd class="tab-num">{fmtInt(h.enrichment.withArtists)} · {pct(h.enrichment.withArtists, h.enrichment.tracks)}</dd>
				<dt>With ISRC</dt><dd class="tab-num">{fmtInt(h.enrichment.withIsrc)} · {pct(h.enrichment.withIsrc, h.enrichment.tracks)}</dd>
				<dt>Last enriched</dt><dd>{ago(h.enrichment.lastEnrichedAt, now)}</dd>
				<dt>Audio features</dt><dd class="muted">not collected (Spotify closed that endpoint to new apps in Nov 2024)</dd>
			</dl>
		</section>

		<section class="section" aria-labelledby="h-roll">
			<div class="sec-h"><h2 id="h-roll">Stats rollups</h2></div>
			{#if h.rollups}
				<dl data-testid="health-rollups">
					<dt>Refreshed</dt><dd>{@render dot(h.rollups.tone)} {ago(h.rollups.refreshedAt, now)} <span class="muted">({fmtInt(h.rollups.tookMs ?? 0)} ms)</span></dd>
					<dt>Covers plays ingested up to</dt><dd>{dt(h.rollups.ingestedMark)}</dd>
					<dt>Last full rebuild</dt><dd>{dt(h.rollups.fullRebuiltAt)}</dd>
				</dl>
			{:else}
				<p class="cap muted">No rollups yet (migration 0023).</p>
			{/if}
		</section>

		<section class="section" aria-labelledby="h-db">
			<div class="sec-h"><h2 id="h-db">Database size</h2></div>
			<p class="cap" data-testid="health-db">{@render dot(h.database.tone)} <b class="tab-num">{fmtBytes(h.database.bytes)}</b> of {fmtBytes(h.database.capBytes)} (Supabase free tier) · {h.database.pct}%</p>
			<div class="meter" role="meter" aria-label="Database size" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.min(100, h.database.pct)}>
				<i style="width:{Math.min(100, h.database.pct)}%;background:{TONE_COLOR[h.database.tone === 'info' ? 'ok' : h.database.tone]}"></i>
			</div>
			<ul class="tables cap muted">
				{#each h.database.tables as t (t.name)}<li><span>{t.name}</span><span class="tab-num">{fmtBytes(t.bytes)}</span></li>{/each}
			</ul>
		</section>

		<section class="section" aria-labelledby="h-tok">
			<div class="sec-h"><h2 id="h-tok">Spotify tokens</h2></div>
			<ul class="rows" data-testid="health-tokens">
				{#each h.tokens as t (t.client)}
					<li data-client={t.client} data-tone={t.tone}>
						{@render dot(t.tone)}
						<span class="l"><b>{t.client === 'hub' ? 'Rotor (this app)' : 'Crons'}</b>{#if t.lastError}<span class="cap" style="color:var(--danger)"> · {t.lastError}</span>{/if}</span>
						<span class="v">{#if t.connected}stops ≈ {fmtDate(t.expiresAt)} <span class="tab-num">({t.daysLeft} d)</span>{:else}{t.client === 'cron' ? 'GitHub secret (not tracked here)' : 'not connected'}{/if}</span>
					</li>
				{/each}
			</ul>
		</section>

		<section class="section" aria-labelledby="h-push">
			<div class="sec-h"><h2 id="h-push">Notification devices</h2><a class="more" href="/settings">Settings</a></div>
			{#if !h.devices.length}
				<p class="cap" data-testid="health-push-none" style="color:var(--warning)">No device is subscribed: notifications (the only channel since v0.89) reach nobody. Turn them on in Settings › Notifications.</p>
			{:else}
				<ul class="rows" data-testid="health-push">
					{#each h.devices as d, i (i)}
						{@const tone: Tone = d.warning === 'failing' ? 'danger' : d.warning === 'silent' ? 'warn' : 'ok'}
						<li data-tone={tone} data-warning={d.warning ?? ''}>
							{@render dot(tone)}
							<span class="l"><b>{d.label}</b><span class="cap muted">subscribed {fmtDate(d.createdAt)}</span>
								{#if d.warning === 'failing'}<span class="cap" style="color:var(--danger)">Last {d.failures} deliver{d.failures === 1 ? 'y' : 'ies'} failed. Turn notifications off and on again on that device.</span>
								{:else if d.warning === 'silent'}<span class="cap" style="color:var(--warning)">Nothing received in 7 days. Send a test from Settings to check it.</span>{/if}
							</span>
							<span class="v">{d.lastSuccessAt ? `last push ${ago(d.lastSuccessAt, now)}` : 'never received one'}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="section" aria-labelledby="h-radar">
			<div class="sec-h"><h2 id="h-radar">Release radar sources</h2></div>
			{#if h.radar}
				<ul class="rows" data-testid="health-radar">
					{#each h.radar as s (s.source)}
						{@const tone: Tone = !s.enabled ? 'info' : s.consecutiveFailures >= 3 ? 'danger' : s.consecutiveFailures > 0 ? 'warn' : s.lastSuccessAt ? 'ok' : 'info'}
						<li data-source={s.source} data-tone={tone}>
							{@render dot(tone)}
							<span class="l"><b>{radarName[s.source]}</b>{#if !s.enabled}<span class="cap muted"> · off{s.disabledReason ? `: ${s.disabledReason}` : ''}</span>{:else if s.lastError}<span class="cap" style="color:var(--warning)"> · {s.lastError}{s.failingSince ? ` (since ${s.failingSince})` : ''}</span>{/if}</span>
							<span class="v">{s.lastSuccessAt ? `ok ${ago(s.lastSuccessAt, now)}` : 'never succeeded'}{#if s.lastItems !== null} · {fmtInt(s.lastItems)} items{/if}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="cap muted">Not set up (migration 0028).</p>
			{/if}
		</section>

		<section class="section" aria-labelledby="h-ph">
			<div class="sec-h"><h2 id="h-ph">Phantom plays</h2><a class="more" href="/settings/health/phantom">See all</a></div>
			<p class="cap" data-testid="health-phantom"><b class="tab-num">{fmtInt(h.phantom.count)}</b> plays of tracks Spotify no longer describes{#if h.phantom.latestAt}, latest {fmtDate(h.phantom.latestAt)}{/if}.</p>
		</section>

		<section class="section" aria-labelledby="h-dg">
			<div class="sec-h"><h2 id="h-dg">Digest</h2><a class="more" href="/digest">This week</a></div>
			{#if h.digest === null}
				<p class="cap muted">Digests aren't stored yet (apply migration 0029). Older weeks are rebuilt from rank history.</p>
			{:else if h.digest.lastAt}
				<p class="cap" data-testid="health-digest">Last {h.digest.runType} digest {ago(h.digest.lastAt, now)} · {h.digest.delivery ? ({ push_sent: 'pushed', push_no_device: 'no device to push to', push_off: 'notification off', mail_sent: 'mailed', mail_failed: 'mail failed' } as Record<string, string>)[h.digest.delivery] ?? h.digest.delivery : 'being delivered'}.</p>
			{:else}
				<p class="cap muted">No digest stored yet: the first one arrives with the next Monday refresh.</p>
			{/if}
		</section>
		<p class="cap muted foot">Checked {dt(h.generatedAt)}. GitHub data is cached for 5 minutes. <a href="/settings/health?fresh=1" data-sveltekit-replacestate data-testid="health-refresh">Check again</a></p>
	{/if}
</div>

<style>
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
		font-size: 13px;
	}
	.rows li {
		display: grid;
		grid-template-columns: 10px 1fr auto;
		gap: 10px;
		align-items: baseline;
	}
	.rows .l {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.rows .l > b + .cap {
		display: inline;
	}
	.v {
		color: var(--text-2);
		text-align: right;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 16px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		color: var(--text-3);
	}
	dd {
		margin: 0;
	}
	.meter {
		height: 8px;
		border-radius: 4px;
		background: var(--surface-2);
		overflow: hidden;
		margin: 6px 0 10px;
	}
	.meter i {
		display: block;
		height: 100%;
	}
	.tables {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 2px;
		max-width: 360px;
	}
	.tables li {
		display: flex;
		justify-content: space-between;
	}
	.more {
		font-size: 13px;
		color: var(--text-2);
	}
	.foot {
		margin-top: 28px;
	}
</style>
