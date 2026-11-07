<script lang="ts">
	import { onMount } from 'svelte';
	import DeviceStrip from '$lib/components/DeviceStrip.svelte';
	import Header from '$lib/components/Header.svelte';
	import Hero from '$lib/components/Hero.svelte';
	import PlaylistCard from '$lib/components/PlaylistCard.svelte';
	import Shortcut from '$lib/components/Shortcut.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { daily } from '$lib/stores/daily.svelte';
	import { delta, fmtDate, fmtInt, greeting } from '$lib/shared/format';
	import { artistHref, badgeIcon, badgeLabel, describeBadge, trackHref } from '$lib/shared/stats';
	import { player } from '$lib/stores/player.svelte';
	import type { HomePayload } from '$lib/shared/daily-types';
	import { radarDate } from '$lib/shared/radar';
	import { homeWrappedCard } from '$lib/shared/wrapped';

	let { data } = $props();
	let fresh = $state<HomePayload | null>(null);
	const home = $derived(fresh ?? data.home);

	$effect.pre(() => {
		daily.set(home?.daily ?? null);
	});

	// R6: Rotor Wrapped card, 1 Dec → 31 Jan (Amsterdam date). R8: decided in +page.ts, so it is
	// in the server-rendered page (no late insert, no layout shift). After mount the device's own
	// date is checked once; it only differs when this device's clock disagrees with the server's.
	type Card = ReturnType<typeof homeWrappedCard>;
	let deviceCard = $state<Card | undefined>(undefined);
	const wrappedCard = $derived(deviceCard === undefined ? data.wrappedCard : deviceCard);

	onMount(() => {
		const mine = homeWrappedCard(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
		if (JSON.stringify(mine) !== JSON.stringify(data.wrappedCard)) deviceCard = mine;
		// Opened from the service worker's cache: show it, then swap in fresh data.
		if (data.stale) {
			fetch('/api/home', { cache: 'no-store' })
				.then((r) => (r.ok ? r.json() : null))
				.then((h: HomePayload | null) => h && (fresh = h))
				.catch(() => undefined);
		}
	});

	const health = $derived.by(() => {
		if (!home) return { level: 'danger' as const, label: 'Rotor can’t reach its data' };
		const order = { ok: 0, warn: 1, danger: 2 } as const;
		const level = order[home.health.ingest] >= order[home.health.token] ? home.health.ingest : home.health.token;
		const ago = home.health.lastPlayAt ? Math.round((Date.now() - Date.parse(home.health.lastPlayAt)) / 60000) : null;
		const ingest = ago === null ? 'no plays ingested' : ago < 90 ? `last play synced ${ago} min ago` : `last play synced ${Math.round(ago / 60)} h ago`;
		const token = home.health.tokenDaysLeft !== null ? `Spotify sign-in: ${home.health.tokenDaysLeft} days left` : 'Spotify not connected';
		return { level, label: `${ingest} · ${token}` };
	});
	const t = $derived(home?.tiles);
	const weekDelta = $derived(t ? delta(t.playsThisWeek, t.playsLastWeekSamePoint) : null);
	const st = $derived(home?.stats ?? null);
</script>

<svelte:head><title>Rotor</title></svelte:head>

<div class="view">
	<Header title={greeting()} health={health.level} healthLabel={health.label} />
	<DeviceStrip />
	{#if data.error && !home}
		<p class="notice">Rotor couldn't load Home ({data.error}). Check that migrations 0019–0021 are applied and the database connection is configured.</p>
	{/if}
	<Hero initial={home?.daily ?? null} />

	{#if home?.shortcuts.length}
		<div class="shortcuts">
			{#each home.shortcuts as p (p.uri)}<Shortcut {p} />{/each}
		</div>
	{/if}

	{#if t}
		<section class="section">
			<div class="sec-h"><h2>Your week</h2></div>
			<div class="tiles">
				<StatTile label="Plays this week" value={fmtInt(t.playsThisWeek)} note={weekDelta?.text} dir={weekDelta?.dir} spark={t.perDay} />
				<StatTile label="Hours this week" value={String(t.hoursThisWeek)} unit="h" spark={t.perDay} sparkColor="var(--data-2)" />
				{#if st}
					<StatTile label="Current streak" value={fmtInt(st.streak.current)} unit="days" note={st.streak.listenedToday ? `longest ${fmtInt(st.streak.longest)}` : 'play something today to keep it'} />
				{/if}
				<StatTile label="Top artist · {t.monthLabel}" value={t.topArtistMonth?.name ?? '—'} small note={t.topArtistMonth ? `${fmtInt(t.topArtistMonth.plays)} plays` : undefined} />
				{#if st}
					<StatTile label="Hours · {t.monthLabel}" value={String(st.month.hours)} unit="h" note="{fmtInt(st.month.plays)} plays" />
					<StatTile label="New artists · {t.monthLabel}" value={fmtInt(st.month.newArtists)} />
				{/if}
			</div>
		</section>
	{/if}

	{#if wrappedCard}
		<a class="wrapped" href="/wrapped/{wrappedCard.year}?from=/home" data-testid="home-wrapped">
			<span class="w-over">Rotor Wrapped</span>
			<strong>{wrappedCard.year}{wrappedCard.mode === 'so_far' ? ' so far' : ''}</strong>
			<span class="cap">{wrappedCard.mode === 'so_far' ? 'Your year until today, the full year on 1 January' : 'Your full year is ready: every day, 1 January – 31 December'}</span>
		</a>
	{/if}

	{#if home?.fresh.length}
		<section class="section">
			<div class="sec-h"><h2>Fresh</h2></div>
			<div class="shelf">{#each home.fresh as p (p.uri)}<PlaylistCard {p} />{/each}</div>
		</section>
	{/if}

	{#if st?.onThisDay.length}
		<section class="section">
			<div class="sec-h"><h2>On this day</h2><a class="cap" href="/stats/onthisday">All years</a></div>
			<div class="shelf">
				{#each st.onThisDay as y (y.year)}
					<div class="otd">
						<a class="otd-b" href="/stats/onthisday?year={y.year}">
							<span class="over">{y.year}</span>
							<span class="otd-t ell">{y.top?.track ?? '—'}</span>
							<span class="cap muted ell">{y.top?.artist ?? ''}</span>
							<span class="cap">{fmtInt(y.plays)} plays that day</span>
						</a>
						{#if y.uris.length}
							<button class="ibtn otd-p" aria-label="Play what you played on this day in {y.year}" onclick={() => player.play({ type: 'play', body: { uris: y.uris.slice(0, 100) }, label: `On this day · ${y.year}` })}>▶</button>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if st?.recentBadges.length}
		<section class="section">
			<div class="sec-h"><h2>Recent badges</h2><a class="cap" href="/stats/badges">All badges</a></div>
			<div class="shelf">
				{#each st.recentBadges as b (b.entityType + b.entityId + b.badgeType + b.awardedAt)}
					{@const href = b.entityType === 'track' ? trackHref(b.entityId) : artistHref(b.entityId)}
					<a class="bdg" href={href ?? '/stats/badges'} title={describeBadge(b.badgeType, b.context)}>
						{#if badgeIcon(b.badgeType)}<img src={badgeIcon(b.badgeType)} alt="" width="56" height="56" loading="lazy" />{:else}<span class="bdg-ph" aria-hidden="true">★</span>{/if}
						<span class="bdg-n">{badgeLabel(b.badgeType)}</span>
						<span class="cap ell">{b.name ?? ''}</span>
						<span class="cap muted">{fmtDate(b.awardedAt, { day: 'numeric', month: 'short' })}</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	{#if home?.comingBack.length}
		<section class="section">
			<div class="sec-h"><h2>Coming back around</h2></div>
			<div class="shelf">{#each home.comingBack as p (p.uri)}<PlaylistCard {p} />{/each}</div>
		</section>
	{/if}

	{#if home?.comingUp?.length}
		<section class="section" aria-label="Coming up">
			<div class="sec-h"><h2>Coming up</h2><a class="cap" href="/radar">Release radar</a></div>
			<ul class="coming">
				{#each home.comingUp as it (it.id)}
					<li><span class="cu-d cap">{radarDate(it.date, it.precision)}</span><span class="cu-t"><b>{it.title}</b><span class="cap">{it.artist}{it.label ? ` · ${it.label}` : ''}</span></span></li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if home?.elsewhere}
		<!-- Elsewhere: one quiet link card at the very bottom, no YouTube/SoundCloud artwork or items (03-ux-ia.md §3). -->
		<a class="elsewhere" href="/elsewhere">
			<span><b>Elsewhere</b><span class="cap muted">{home.elsewhere.youtube + home.elsewhere.soundcloud ? `${home.elsewhere.youtube + home.elsewhere.soundcloud} YouTube & SoundCloud collection${home.elsewhere.youtube + home.elsewhere.soundcloud === 1 ? '' : 's'}` : 'Import YouTube & SoundCloud collections'}</span></span>
			<span aria-hidden="true">→</span>
		</a>
	{/if}

	<p class="cap muted foot">Spotify content is played in Spotify; Rotor never edits playlists without a managed suffix.</p>
</div>

<style>
	.coming {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 2px;
	}
	.coming li {
		display: flex;
		gap: 12px;
		align-items: baseline;
		padding: 8px 12px;
		border-radius: 10px;
		background: var(--surface-2);
	}
	.cu-d {
		flex: none;
		width: 92px;
		color: var(--data-3);
	}
	.cu-t {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.wrapped {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 8px 0 20px;
		padding: 20px;
		border-radius: 16px;
		background: linear-gradient(150deg, #3b1f7a, #123f48 70%, var(--bg));
	}
	.wrapped strong {
		font-size: 28px;
		font-weight: 800;
		color: var(--text-1);
	}
	.w-over {
		color: var(--accent);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
	.shortcuts {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		margin-top: 20px;
	}
	.tiles {
		display: flex;
		gap: 10px;
		overflow-x: auto;
		scrollbar-width: none;
		margin: 0 calc(-1 * var(--gutter));
		padding: 0 var(--gutter) 2px;
	}
	.shelf {
		display: flex;
		gap: 12px;
		overflow-x: auto;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: var(--gutter);
		scrollbar-width: none;
		margin: 0 calc(-1 * var(--gutter));
		padding: 0 var(--gutter) 4px;
	}
	.foot {
		margin-top: 28px;
	}
	.elsewhere {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 28px;
		padding: 14px 16px;
		border-radius: var(--r-card);
		background: var(--surface-1);
		border: 1px solid var(--border);
		color: var(--text-1);
	}
	.elsewhere > span:first-child {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.otd {
		flex: none;
		width: 168px;
		position: relative;
		scroll-snap-align: start;
	}
	.otd-b {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px;
		min-height: 112px;
		border-radius: var(--r-card);
		background: var(--surface-2);
		color: var(--text-1);
	}
	.otd-t {
		font-weight: 700;
		font-size: 14px;
	}
	.otd-p {
		position: absolute;
		right: 6px;
		bottom: 6px;
	}
	.bdg {
		flex: none;
		width: 112px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		text-align: center;
		color: var(--text-1);
		scroll-snap-align: start;
	}
	.bdg img,
	.bdg-ph {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		background: var(--surface-3);
		display: grid;
		place-items: center;
	}
	.bdg-n {
		font-size: 13px;
		font-weight: 700;
	}
	.bdg .ell {
		max-width: 100%;
	}
	@media (min-width: 768px) {
		.shortcuts {
			grid-template-columns: repeat(3, 1fr);
		}
		.tiles {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
			overflow: visible;
			margin: 0;
			padding: 0;
		}
		.shelf {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
			overflow: visible;
			margin: 0;
			padding: 0;
			gap: 4px;
		}
	}
</style>
