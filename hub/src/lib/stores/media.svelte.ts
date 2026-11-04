import { browser } from '$app/environment';

/** Reactive breakpoint flags (05-design.md §4: < 768 mobile, ≥ 1180 three columns). */
class MediaStore {
	laptop = $state(false);
	wide = $state(false);

	constructor() {
		if (!browser) return;
		const lap = window.matchMedia('(min-width: 768px)');
		const wide = window.matchMedia('(min-width: 1180px)');
		this.laptop = lap.matches;
		this.wide = wide.matches;
		lap.addEventListener('change', (e) => (this.laptop = e.matches));
		wide.addEventListener('change', (e) => (this.wide = e.matches));
	}
}

export const media = new MediaStore();
