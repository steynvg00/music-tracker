<script lang="ts">
	import { fmtTime } from '$lib/shared/format';
	/** Progress + seek. Informational only (no thumb, no seeking) when Spotify disallows seeking. */
	let {
		position,
		duration,
		disabled = false,
		onseek,
		variant = 'bar'
	}: { position: number; duration: number; disabled?: boolean; onseek: (ms: number) => void; variant?: 'bar' | 'full' } = $props();

	let dragging = $state<number | null>(null);
	let track: HTMLDivElement | undefined = $state();
	const shown = $derived(dragging ?? position);
	const pct = $derived(duration > 0 ? Math.min(100, (shown / duration) * 100) : 0);

	function at(clientX: number): number {
		const r = track!.getBoundingClientRect();
		return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration);
	}
	function down(e: PointerEvent) {
		if (disabled || !duration) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragging = at(e.clientX);
	}
	function move(e: PointerEvent) {
		if (dragging !== null) dragging = at(e.clientX);
	}
	function up() {
		if (dragging === null) return;
		const ms = dragging;
		dragging = null;
		onseek(ms);
	}
	function key(e: KeyboardEvent) {
		if (disabled) return;
		const step = e.shiftKey ? 30_000 : 5_000;
		if (e.key === 'ArrowRight') onseek(Math.min(duration, position + step));
		else if (e.key === 'ArrowLeft') onseek(Math.max(0, position - step));
		else return;
		e.preventDefault();
		e.stopPropagation();
	}
</script>

<div class="scrub {variant}" class:disabled>
	{#if variant === 'bar'}<span class="t tab-num">{fmtTime(shown)}</span>{/if}
	<div
		class="trk"
		bind:this={track}
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label="Seek"
		aria-valuemin={0}
		aria-valuemax={Math.round(duration / 1000)}
		aria-valuenow={Math.round(shown / 1000)}
		aria-valuetext={fmtTime(shown)}
		aria-disabled={disabled}
		title={disabled ? 'Seeking isn’t allowed here' : undefined}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={() => (dragging = null)}
		onkeydown={key}
	>
		<i style="width:{pct}%" class:live={dragging === null}></i>
		{#if !disabled}<b style="left:{pct}%"></b>{/if}
	</div>
	{#if variant === 'bar'}
		<span class="t tab-num">{fmtTime(duration)}</span>
	{:else}
		<div class="times tab-num"><span>{fmtTime(shown)}</span><span>-{fmtTime(Math.max(0, duration - shown))}</span></div>
	{/if}
</div>

<style>
	.scrub.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		font-size: 12px;
		color: var(--text-3);
	}
	.trk {
		flex: 1;
		height: 16px;
		position: relative;
		cursor: pointer;
		touch-action: none;
	}
	.trk::before {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 6px;
		height: 4px;
		border-radius: 2px;
		background: var(--surface-4);
	}
	.full .trk::before {
		background: rgba(255, 255, 255, 0.18);
	}
	.trk i {
		position: absolute;
		left: 0;
		top: 6px;
		height: 4px;
		background: var(--text-1);
		border-radius: 2px;
	}
	.trk i.live {
		transition: width 250ms linear;
	}
	.trk:hover i {
		background: var(--accent);
	}
	.trk b {
		position: absolute;
		top: 8px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text-1);
		transform: translate(-50%, -50%);
		opacity: 0;
		transition: opacity var(--t-micro);
	}
	.trk:hover b,
	.full .trk b {
		opacity: 1;
	}
	.disabled .trk {
		cursor: default;
	}
	.disabled .trk:hover i {
		background: var(--text-1);
	}
	.times {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: var(--text-2);
		margin-top: 2px;
	}
	.t {
		min-width: 36px;
		text-align: center;
	}
</style>
