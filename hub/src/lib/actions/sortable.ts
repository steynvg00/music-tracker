/**
 * Drag to reorder (v0.91): pinned items and the custom order. Laptop: drag by the handle with the
 * mouse. iPhone: long-press a row (350 ms, without moving), then drag. Keyboard: focus the handle,
 * ArrowUp / ArrowDown. Children carry data-sort-index; nothing is reordered in the DOM here: the
 * caller gets onreorder(from, to) and re-renders.
 */
export interface SortableOptions {
	onreorder: (from: number, to: number) => void;
	disabled?: boolean;
	longPressMs?: number;
}

export function sortable(node: HTMLElement, opts: SortableOptions) {
	let o = opts;
	let drag: { el: HTMLElement; from: number; startY: number; pointerId: number; to: number } | null = null;
	let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number; el: HTMLElement; pointerId: number } | null = null;
	let suppressClick = false;

	const items = () => [...node.querySelectorAll<HTMLElement>(':scope > [data-sort-index]')];
	const indexOf = (el: HTMLElement) => Number(el.dataset.sortIndex);

	function start(el: HTMLElement, y: number, pointerId: number) {
		drag = { el, from: indexOf(el), startY: y, pointerId, to: indexOf(el) };
		el.classList.add('dragging');
		node.classList.add('sorting');
		try {
			node.setPointerCapture(pointerId);
		} catch {
			/* synthetic events (tests) have no capturable pointer */
		}
	}
	function targetIndex(y: number): number {
		const list = items();
		let to = drag!.from;
		for (const it of list) {
			if (it === drag!.el) continue;
			const r = it.getBoundingClientRect();
			const i = indexOf(it);
			if (i < drag!.from && y < r.top + r.height / 2) return i;
			if (i > drag!.from && y > r.top + r.height / 2) to = i;
		}
		return to;
	}
	function move(y: number) {
		if (!drag) return;
		drag.el.style.transform = `translateY(${y - drag.startY}px)`;
		const to = targetIndex(y);
		drag.to = to;
		for (const it of items()) {
			it.classList.toggle('drop-before', it !== drag.el && indexOf(it) === to && to < drag.from);
			it.classList.toggle('drop-after', it !== drag.el && indexOf(it) === to && to > drag.from);
		}
	}
	function end(commit: boolean) {
		if (press) clearTimeout(press.timer);
		press = null;
		if (!drag) return;
		const { el, from, to } = drag;
		el.style.transform = '';
		el.classList.remove('dragging');
		node.classList.remove('sorting');
		for (const it of items()) it.classList.remove('drop-before', 'drop-after');
		drag = null;
		suppressClick = true;
		setTimeout(() => (suppressClick = false), 0);
		if (commit && to !== from) o.onreorder(from, to);
	}

	function down(e: PointerEvent) {
		if (o.disabled) return;
		const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sort-index]');
		if (!el || el.parentElement !== node) return;
		const onHandle = !!(e.target as HTMLElement).closest('[data-sort-handle]');
		if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
			if (!onHandle) return;
			e.preventDefault();
			start(el, e.clientY, e.pointerId);
			return;
		}
		// Touch: long-press anywhere on the row.
		press = {
			x: e.clientX,
			y: e.clientY,
			el,
			pointerId: e.pointerId,
			timer: setTimeout(() => {
				if (!press) return;
				start(press.el, press.y, press.pointerId);
				navigator.vibrate?.(10);
			}, o.longPressMs ?? 350)
		};
	}
	function moved(e: PointerEvent) {
		if (press && !drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) {
			clearTimeout(press.timer);
			press = null;
		}
		if (drag && e.pointerId === drag.pointerId) {
			e.preventDefault();
			move(e.clientY);
		}
	}
	const up = () => end(true);
	const cancel = () => end(false);
	/** A drag (or a long-press) must not also open the row. */
	function click(e: MouseEvent) {
		if (drag || suppressClick) {
			e.preventDefault();
			e.stopPropagation();
		}
	}
	function touchmove(e: TouchEvent) {
		if (drag) e.preventDefault();
	}
	function contextmenu(e: Event) {
		if (press || drag) e.preventDefault(); // iOS/Android long-press menu
	}
	function key(e: KeyboardEvent) {
		const h = (e.target as HTMLElement).closest('[data-sort-handle]');
		if (!h || o.disabled || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
		const el = h.closest<HTMLElement>('[data-sort-index]');
		if (!el) return;
		e.preventDefault();
		const from = indexOf(el);
		const to = e.key === 'ArrowUp' ? from - 1 : from + 1;
		if (to >= 0 && to < items().length) o.onreorder(from, to);
	}

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', moved);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('click', click, true);
	node.addEventListener('touchmove', touchmove, { passive: false });
	node.addEventListener('contextmenu', contextmenu);
	node.addEventListener('keydown', key);
	return {
		update(next: SortableOptions) {
			o = next;
		},
		destroy() {
			end(false);
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', moved);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('click', click, true);
			node.removeEventListener('touchmove', touchmove);
			node.removeEventListener('contextmenu', contextmenu);
			node.removeEventListener('keydown', key);
		}
	};
}
