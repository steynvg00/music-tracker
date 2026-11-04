<script lang="ts">
	import { onMount } from 'svelte';
	import DeviceStrip from '$lib/components/DeviceStrip.svelte';
	import Header from '$lib/components/Header.svelte';
	import Hero from '$lib/components/Hero.svelte';
	import PlaylistCard from '$lib/components/PlaylistCard.svelte';
	import Shortcut from '$lib/components/Shortcut.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { daily } from '$lib/stores/daily.svelte';
	import { media } from '$lib/stores/media.svelte';
	import { delta, fmtInt, greeting } from '$lib/shared/format';
	import type { HomePayload } from '$lib/shared/daily-types';

	let { data } = $props();
	let fresh = $state<HomePayload | null>(null);
	const home = $derived(fresh ?? data.home);

	$effect.pre(() => {
		daily.set(home?.daily ?? null);
	});

	onMount(() => {
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
</script>

<svelte:head><title>Rotor</title></svelte:head>

<div class="view">
	<Header title={greeting()} health={health.level} healthLabel={health.label} />
	<DeviceStrip />
	{#if data.error && !home}
		<p class="notice">Rotor couldn't load Home ({data.error}). Check that migrations 0019–0021 are applied and the database connection is configured.</p>
	{/if}
	<Hero wide={media.laptop} />

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
				<StatTile label="Top artist · {t.monthLabel}" value={t.topArtistMonth?.name ?? '—'} small note={t.topArtistMonth ? `${fmtInt(t.topArtistMonth.plays)} plays` : undefined} />
			</div>
		</section>
	{/if}

	{#if home?.fresh.length}
		<section class="section">
			<div class="sec-h"><h2>Fresh</h2></div>
			<div class="shelf">{#each home.fresh as p (p.uri)}<PlaylistCard {p} />{/each}</div>
		</section>
	{/if}

	{#if home?.comingBack.length}
		<section class="section">
			<div class="sec-h"><h2>Coming back around</h2></div>
			<div class="shelf">{#each home.comingBack as p (p.uri)}<PlaylistCard {p} />{/each}</div>
		</section>
	{/if}

	<p class="cap muted foot">Streaks, On this day and badges arrive with the stats release. Spotify content is played in Spotify; Rotor never edits playlists without a managed suffix.</p>
</div>

<style>
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
