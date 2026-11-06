<script lang="ts">
	/**
	 * Rotor Wrapped story player (R6, 03-ux-ia.md §9). Fullscreen cards with a segmented progress
	 * bar. iPhone: tap right ⅔ = next, left ⅓ = back, swipe left/right, swipe down = close, hold =
	 * pause. Laptop: ← / →, Space = pause, Esc = close. Reduced motion: no auto-advance.
	 * Cards are SVG strings (lib/wrapped/cards.ts); "Save image" exports the same SVG as a PNG.
	 */
	import { onMount } from 'svelte';
	import { CARD_H, CARD_W, describeCard, renderCard, svgToPng } from '$lib/wrapped/cards';
	import { approxMark, hoursOf, wrappedCards, type WrappedPayload } from '$lib/shared/wrapped';
	import { fmtInt } from '$lib/shared/format';
	import { trackHref } from '$lib/shared/stats';
	import { player } from '$lib/stores/player.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { describeFailure } from '$lib/player/api-client';

	let {
		payload,
		mode,
		playlistName,
		onclose
	}: { payload: WrappedPayload; mode: 'so_far' | 'frozen'; playlistName: string; onclose: () => void } = $props();

	const DURATION = 7000;
	const HOLD_MS = 220;
	const cards = $derived(wrappedCards(payload));
	let index = $state(0);
	let elapsed = $state(0);
	let held = $state(false);
	let keyPaused = $state(false);
	let listsOpen = $state(false);
	let saving = $state(false);
	let reduced = $state(false);
	const kind = $derived(cards[Math.min(index, cards.length - 1)]!);
	const svg = $derived(renderCard(kind, payload));
	const paused = $derived(held || keyPaused || listsOpen || saving || reduced);
	const last = $derived(index >= cards.length - 1);

	function go(i: number) {
		if (i < 0) i = 0;
		if (i > cards.length - 1) {
			index = cards.length - 1;
			elapsed = DURATION;
			return;
		}
		index = i;
		elapsed = 0;
	}
	const next = () => go(index + 1);
	const prev = () => go(index - 1);

	onMount(() => {
		reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
		let raf = 0;
		let t0 = performance.now();
		const tick = (t: number) => {
			const dt = t - t0;
			t0 = t;
			if (!paused && !last && document.visibilityState === 'visible') {
				elapsed += dt;
				if (elapsed >= DURATION) next();
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		const onKey = (e: KeyboardEvent) => {
			if (listsOpen) {
				if (e.key === 'Escape') listsOpen = false;
				return;
			}
			if (e.key === 'ArrowRight') (e.preventDefault(), next());
			else if (e.key === 'ArrowLeft') (e.preventDefault(), prev());
			else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) (e.preventDefault(), (keyPaused = !keyPaused));
			else if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});

	// ── touch / mouse on the card area ──
	let down: { x: number; y: number; t: number; timer: ReturnType<typeof setTimeout> } | null = null;
	function onDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const timer = setTimeout(() => (held = true), HOLD_MS);
		down = { x: e.clientX, y: e.clientY, t: performance.now(), timer };
	}
	function onUp(e: PointerEvent, el: HTMLElement) {
		if (!down) return;
		clearTimeout(down.timer);
		const dx = e.clientX - down.x;
		const dy = e.clientY - down.y;
		const wasHold = held;
		held = false;
		down = null;
		if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? next() : prev();
		if (dy > 90 && Math.abs(dy) > Math.abs(dx)) return onclose();
		if (wasHold) return; // released after holding: just resume
		const r = el.getBoundingClientRect();
		if (e.clientX - r.left < r.width / 3) prev();
		else next();
	}
	function onCancel() {
		if (down) clearTimeout(down.timer);
		down = null;
		held = false;
	}

	async function save() {
		saving = true;
		try {
			const blob = await svgToPng(svg, CARD_W, CARD_H);
			const file = new File([blob], `rotor-wrapped-${payload.year}-${index + 1}-${kind}.png`, { type: 'image/png' });
			const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
			// Share sheet on touch devices (iPhone: Save to Photos); a download everywhere else.
			const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
			if (coarse && nav.canShare?.({ files: [file] }) && nav.share) {
				await nav.share({ files: [file], title: `Rotor Wrapped ${payload.year}` }).catch((e: unknown) => {
					if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
				});
			} else {
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = file.name;
				document.body.append(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 10_000);
				toasts.show('Image saved');
			}
		} catch (e) {
			toasts.error(`Couldn't save the image: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			saving = false;
		}
	}

	let playing = $state(false);
	async function playTop() {
		playing = true;
		try {
			const ok = await player.playWrapped(payload.year, `Your top 100 · ${payload.year}`);
			if (ok) toasts.show(`Playing ${playlistName}`);
		} catch (e) {
			toasts.error(describeFailure(e));
		} finally {
			playing = false;
		}
	}
	const stop = (e: Event) => e.stopPropagation();
	const progress = (i: number) => (i < index ? 1 : i > index ? 0 : last ? 1 : Math.min(1, elapsed / DURATION));
</script>

<div class="story" role="dialog" aria-modal="true" aria-label="Rotor Wrapped {payload.year}" data-card={kind} data-index={index} data-paused={paused ? 'true' : 'false'}>
	<div class="frame">
		<div class="bars" aria-hidden="true">
			{#each cards as c, i (c)}
				<span class="bar"><span class="fill" style="transform: scaleX({progress(i)})"></span></span>
			{/each}
		</div>
		<div class="top">
			<span class="cap">{index + 1} / {cards.length}{paused && !reduced ? ' · paused' : ''}</span>
			<button class="x" aria-label="Close Rotor Wrapped" onpointerdown={stop} onpointerup={stop} onclick={onclose}>✕</button>
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="card"
			onpointerdown={onDown}
			onpointerup={(e) => onUp(e, e.currentTarget)}
			onpointercancel={onCancel}
			onpointerleave={onCancel}
			oncontextmenu={(e) => e.preventDefault()}
		>
			<div class="svg" role="img" aria-label={describeCard(kind, payload)}>{@html svg}</div>
		</div>
		<p class="sr" aria-live="polite">{describeCard(kind, payload)}</p>
		<div class="acts">
			<button class="btn" onpointerdown={stop} onpointerup={stop} onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save image'}</button>
			{#if last}
				{#if payload.topTracks.length}
					<button class="btn pri" onpointerdown={stop} onpointerup={stop} onclick={playTop} disabled={playing}>{playing ? 'Writing playlist…' : 'Play your top 100'}</button>
				{/if}
				<button class="btn" onpointerdown={stop} onpointerup={stop} onclick={() => (listsOpen = true)}>Top 100 lists</button>
			{:else}
				<button class="btn ghost" onpointerdown={stop} onpointerup={stop} onclick={() => (keyPaused = !keyPaused)} aria-pressed={keyPaused}>{keyPaused ? 'Resume' : 'Pause'}</button>
			{/if}
		</div>
		{#if last && payload.topTracks.length}
			<p class="note cap">"Play your top 100" writes only <b>{playlistName}</b> (created or replaced{mode === 'so_far' ? ', today’s top' : ''}).</p>
		{/if}
	</div>

	{#if listsOpen}
		<div class="lists" role="dialog" aria-label="Top 100 · {payload.year}">
			<div class="lh">
				<h2>Top 100 · {payload.year}{mode === 'so_far' ? ' so far' : ''}</h2>
				<button class="x" aria-label="Close the lists" onclick={() => (listsOpen = false)}>✕</button>
			</div>
			<div class="cols">
				<section>
					<h3>Tracks</h3>
					<ol>
						{#each payload.topTracks as t (t.rank)}
							<li>
								<span class="rk">{t.rank}</span>
								<span class="nm">{#if trackHref(t.uri)}<a href={trackHref(t.uri)}>{t.track}</a>{:else}{t.track}{/if}<small>{t.artist}</small></span>
								<span class="v">{fmtInt(t.plays)} · {approxMark(payload)}{hoursOf(t.ms ?? 0)} h</span>
							</li>
						{/each}
					</ol>
				</section>
				<section>
					<h3>Artists</h3>
					<ol>
						{#each payload.topArtists as a (a.rank)}
							<li>
								<span class="rk">{a.rank}</span>
								<span class="nm"><a href="/search?q={encodeURIComponent(a.artist)}">{a.artist}</a><small>{fmtInt(a.tracks ?? 0)} tracks</small></span>
								<span class="v">{fmtInt(a.plays)} · {approxMark(payload)}{hoursOf(a.ms ?? 0)} h</span>
							</li>
						{/each}
					</ol>
				</section>
			</div>
		</div>
	{/if}
</div>

<style>
	.story {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: #050507;
		display: grid;
		place-items: center;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}
	.frame {
		position: relative;
		height: 100dvh;
		width: min(100vw, calc(100dvh * 9 / 16));
		display: flex;
		flex-direction: column;
		padding: max(10px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom));
		gap: 8px;
	}
	.bars {
		display: flex;
		gap: 4px;
	}
	.bar {
		flex: 1;
		height: 3px;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.25);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--text-1);
		transform-origin: left;
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		color: var(--text-2);
	}
	.x {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.1);
		color: var(--text-1);
		font-size: 16px;
	}
	.card {
		flex: 1;
		min-height: 0;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.svg {
		height: 100%;
		aspect-ratio: 9 / 16;
		max-width: 100%;
		border-radius: 16px;
		overflow: hidden;
	}
	.svg :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}
	.acts {
		display: flex;
		gap: 8px;
		justify-content: center;
		flex-wrap: wrap;
	}
	.btn.ghost {
		background: transparent;
	}
	.note {
		text-align: center;
		color: var(--text-3);
		margin: 0;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
	.lists {
		position: fixed;
		inset: 0;
		z-index: 61;
		background: var(--bg);
		overflow: auto;
		padding: max(16px, env(safe-area-inset-top)) var(--gutter) 32px;
		touch-action: pan-y;
		user-select: text;
	}
	.lh {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.cols {
		display: grid;
		gap: 24px;
	}
	@media (min-width: 900px) {
		.cols {
			grid-template-columns: 1fr 1fr;
		}
	}
	ol {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	li {
		display: grid;
		grid-template-columns: 36px 1fr auto;
		gap: 10px;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--surface-2);
	}
	.rk {
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.nm {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.nm a,
	.nm small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nm small {
		color: var(--text-2);
	}
	.v {
		color: var(--text-2);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}
</style>
