<script lang="ts">
	import type { Snippet } from 'svelte';
	/** Bottom sheet on mobile, anchored popover-style dialog on laptop (05-design.md §7.4). */
	let {
		open,
		onclose,
		label,
		children,
		wide = false
	}: { open: boolean; onclose: () => void; label: string; children: Snippet; wide?: boolean } = $props();
	let el: HTMLElement | undefined = $state();
	/** Move the node to <body> while mounted, so fixed positioning + z-index are relative to the page root. */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
	let opener: Element | null = null;

	$effect(() => {
		if (open) {
			opener = document.activeElement;
			queueMicrotask(() => (el?.querySelector<HTMLElement>('button, a[href], [tabindex="0"]') ?? el)?.focus());
		} else if (opener instanceof HTMLElement) {
			opener.focus();
			opener = null;
		}
	});

	function trap(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
			return;
		}
		if (e.key !== 'Tab' || !el) return;
		const items = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')];
		if (!items.length) return;
		const first = items[0]!;
		const last = items[items.length - 1]!;
		if (e.shiftKey && document.activeElement === first) {
			last.focus();
			e.preventDefault();
		} else if (!e.shiftKey && document.activeElement === last) {
			first.focus();
			e.preventDefault();
		}
	}
</script>

<!-- Portalled to <body> (R3 fix): a Sheet opened inside a page must stack above the mini-player and
     tab bar, which it can't do from inside the page's own stacking context. -->
<div class="portal" use:portal>
<div class="scrim" class:open onclick={onclose} aria-hidden="true"></div>
<div class="sheet" class:open class:wide bind:this={el} role="dialog" aria-modal="true" aria-label={label} inert={!open} tabindex="-1" onkeydown={trap}>
	<div class="handle"></div>
	{@render children()}
</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 49;
		background: rgba(0, 0, 0, 0.55);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--t-std);
	}
	.scrim.open {
		opacity: 1;
		pointer-events: auto;
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 50;
		background: var(--surface-2);
		border-radius: var(--r-sheet) var(--r-sheet) 0 0;
		padding: 8px 16px calc(var(--safe-bottom) + 16px);
		transform: translateY(105%);
		transition: transform var(--t-sheet) var(--ease-emph);
		max-height: 85vh;
		overflow-y: auto;
		box-shadow: var(--shadow-pop);
		outline: none;
	}
	.sheet.open {
		transform: none;
	}
	.handle {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--surface-4);
		margin: 0 auto 10px;
	}
	@media (min-width: 768px) {
		.scrim.open {
			background: rgba(0, 0, 0, 0.2);
		}
		.sheet {
			left: auto;
			right: 16px;
			bottom: 96px;
			width: 380px;
			border-radius: 12px;
			padding: 12px;
			transform: translateY(12px);
			opacity: 0;
			pointer-events: none;
			transition: all var(--t-std) var(--ease-std);
		}
		.sheet.open {
			transform: none;
			opacity: 1;
			pointer-events: auto;
		}
		.sheet.wide {
			right: auto;
			left: 50%;
			top: 50%;
			bottom: auto;
			width: min(560px, calc(100vw - 48px));
			max-height: min(760px, calc(100vh - 64px));
			transform: translate(-50%, -48%);
			padding: 20px;
		}
		.sheet.wide.open {
			transform: translate(-50%, -50%);
		}
		.scrim.open:has(+ .sheet.wide) {
			background: rgba(0, 0, 0, 0.55);
		}
		.handle {
			display: none;
		}
	}
</style>
