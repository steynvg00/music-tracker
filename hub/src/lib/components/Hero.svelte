<script lang="ts">
	import Art from './Art.svelte';
	import Eq from './Eq.svelte';
	import Icon from './Icon.svelte';
	import KindBadge from './KindBadge.svelte';
	import RotorCover from './RotorCover.svelte';
	import { daily } from '$lib/stores/daily.svelte';
	import { player } from '$lib/stores/player.svelte';
	import { fmtDuration } from '$lib/shared/format';
	import type { DailyDeck } from '$lib/shared/daily-types';
	/**
	 * Today's pick (03-ux-ia.md §4 row 2): Play · Rotate · candidate dots.
	 * R8: the art is 120 px on phones and 200 px from 768 px, chosen by CSS (not by JS after
	 * hydration), so the server-rendered hero already has its final size: no layout shift.
	 * `initial` is the page's deck: the store is filled in an effect, which never runs during
	 * server rendering, so without it the server would render "No pick yet" and the hero would
	 * grow after hydration.
	 */
	let { initial = null }: { initial?: DailyDeck | null } = $props();
	const deck = $derived(daily.deck ?? initial);
	const c = $derived(daily.deck ? daily.current : (initial?.current ?? null));
	const index = $derived(daily.deck ? daily.index : initial && c ? initial.candidates.findIndex((x) => x.rank === c.rank) : -1);
	const isLast = $derived(daily.deck ? daily.isLast : !!c && !!initial && c.rank === Math.max(...initial.candidates.map((x) => x.rank)));
	const playing = $derived(daily.isCurrentContext && player.view.isPlaying);
	const meta = $derived(c ? [c.trackCount ? `${c.trackCount} tracks` : null, fmtDuration(c.durationMs)].filter(Boolean).join(' · ') : '');
</script>

{#if !deck || !c}
	<section class="hero empty">
		<div class="over">Today's pick</div>
		<p class="cap">No pick yet today. The generator runs every morning (cron 04:30 UTC); until the migrations are applied and it has run once, this stays empty.</p>
	</section>
{:else if daily.rotating || daily.reseeding}
	<section class="hero" aria-busy="true">
		<div class="over">{daily.reseeding ? 'Mixing new picks… usually a minute' : "Today's pick"}</div>
		<div class="top">
			<div class="skel hart" style="border-radius:8px;flex:none"></div>
			<div class="info">
				<div class="skel" style="height:14px;width:40%"></div>
				<div class="skel" style="height:24px;width:80%;margin-top:6px"></div>
				<div class="skel" style="height:14px;width:90%;margin-top:6px"></div>
			</div>
		</div>
		<div class="actions">
			<div class="skel" style="width:96px;height:40px;border-radius:999px"></div>
			<div class="skel" style="width:110px;height:40px;border-radius:999px"></div>
		</div>
	</section>
{:else}
	<section class="hero in" style="--hero:{c.kind === 'generated' ? '#5b3bb3' : '#3a3550'}">
		<div class="over">Today's pick · {index + 1} of {deck.candidates.length}</div>
		<div class="top">
			<a href="/daily" class="artlink" aria-label="Open today's pick">
				{#each [120, 200] as size (size)}
					<span class="hsz s{size}">
						{#if c.kind === 'generated'}
							<RotorCover title={c.title} recipe={c.recipe} {size} />
						{:else}
							<Art src={c.playlist?.imageUrl} {size} alt="" />
						{/if}
					</span>
				{/each}
			</a>
			<div class="info">
				<div class="badges">
					{#if c.kind === 'generated'}
						<span class="badge acc">Generated</span>
					{:else}
						<span class="badge">From your library</span>
						<KindBadge kind={c.playlist?.kind ?? null} isOwned={!!c.playlist?.isOwned} isCollab={!!c.playlist?.isCollab} />
					{/if}
				</div>
				<h3><a href="/daily" title={c.title}>{c.title}</a></h3>
				<div class="cap">{c.reason}</div>
				{#if meta}<div class="cap muted">{meta}</div>{/if}
			</div>
		</div>
		<div class="actions">
			<button class="btn pri" onclick={() => daily.play()} aria-label="{playing ? 'Pause' : 'Play'} today's pick">
				{#if playing}<Eq /> Pause{:else}<Icon name="play" size={18} /> Play{/if}
			</button>
			<button class="btn sec" onclick={() => daily.rotate()} disabled={isLast && !deck.reseedAvailable && deck.candidates.length <= 1}>
				<Icon name="rotate" size={18} />
				{isLast ? 'Shuffle the deck' : 'Rotate'}
			</button>
			<div class="dots" aria-hidden="true">
				{#each deck.candidates as x (x.rank)}<i class:on={x.rank === c.rank}></i>{/each}
			</div>
		</div>
	</section>
{/if}

<style>
	.hero {
		margin-top: 16px;
		padding: 16px;
		border-radius: 12px;
		position: relative;
		overflow: hidden;
		background: linear-gradient(160deg, color-mix(in srgb, var(--hero, #5b3bb3) 55%, transparent), var(--surface-2) 75%);
	}
	.hero.empty {
		background: var(--surface-2);
	}
	.hero.empty .cap {
		margin-top: 8px;
	}
	.hero.in {
		animation: rotIn var(--t-rotate) var(--ease-emph);
	}
	@keyframes rotIn {
		from {
			transform: translateX(24px);
			opacity: 0;
		}
	}
	.top {
		display: flex;
		gap: 14px;
		margin-top: 10px;
	}
	.info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.badges {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
	}
	h3 {
		font-size: 22px;
		line-height: 26px;
		font-weight: 800;
		letter-spacing: -0.02em;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
	}
	.dots {
		display: flex;
		gap: 5px;
		margin-left: auto;
		flex-wrap: wrap;
		justify-content: flex-end;
		max-width: 40%;
	}
	.dots i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--surface-4);
	}
	.dots i.on {
		background: var(--text-1);
	}
	.artlink {
		flex: none;
	}
	.hart {
		width: 120px;
		height: 120px;
	}
	.hsz {
		display: block;
	}
	.hsz.s200 {
		display: none;
	}
	@media (min-width: 768px) {
		.hsz.s120 {
			display: none;
		}
		.hsz.s200 {
			display: block;
		}
		.hart {
			width: 200px;
			height: 200px;
		}
		.hero {
			padding: 24px;
		}
		h3 {
			font-size: 34px;
			line-height: 38px;
		}
	}
</style>
