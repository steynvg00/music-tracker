export interface Toast {
	id: number;
	message: string;
	kind: 'info' | 'error';
	action?: { label: string; run: () => void };
}

let seq = 0;

class ToastStore {
	items = $state<Toast[]>([]);

	show(message: string, opts: { kind?: Toast['kind']; action?: Toast['action']; ms?: number } = {}): void {
		const t: Toast = { id: ++seq, message, kind: opts.kind ?? 'info', action: opts.action };
		this.items = [...this.items.slice(-2), t];
		setTimeout(() => this.dismiss(t.id), opts.ms ?? (t.kind === 'error' ? 6000 : 4000));
	}

	error(message: string): void {
		this.show(message, { kind: 'error' });
	}

	dismiss(id: number): void {
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const toasts = new ToastStore();
