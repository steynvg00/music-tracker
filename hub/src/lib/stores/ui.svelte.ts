/** Which overlay is open. One at a time, like the prototype. */
export type Sheet = null | 'devices' | 'player';

class UiStore {
	sheet = $state<Sheet>(null);
	rightPanel = $state(true);
	/** Announced by the aria-live region (track changes). */
	announcement = $state('');
	shakePlay = $state(0);

	open(s: Exclude<Sheet, null>): void {
		this.sheet = s;
	}
	close(): void {
		this.sheet = null;
	}
	announce(msg: string): void {
		this.announcement = msg;
	}
	shake(): void {
		this.shakePlay++;
	}
}

export const ui = new UiStore();
