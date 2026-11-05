/** State of the custom playlist sheet (03-ux-ia.md flow d): create or edit a Custom 🎧 playlist. */
import { goto } from '$app/navigation';
import { apiGet, apiPost, ApiFailure, describeFailure } from '$lib/player/api-client';
import { DEFAULT_FILTERS, type CustomFilters, type Lifetime } from '$lib/shared/custom';
import { library } from '$lib/stores/library.svelte';
import { toasts } from '$lib/stores/toasts.svelte';

export interface PreviewTrack {
	uri: string;
	name: string | null;
	artist: string | null;
	plays: number;
	releaseYear: number | null;
}

const DEBOUNCE_MS = 400;

class CustomSheet {
	open = $state(false);
	mode = $state<'create' | 'edit'>('create');
	step = $state<1 | 2 | 3>(1);
	playlistId = $state<string | null>(null);
	editName = $state('');
	filters = $state<CustomFilters>({ ...DEFAULT_FILTERS });
	excluded = $state<string[]>([]);
	count = $state<number | null>(null);
	tracks = $state<PreviewTrack[]>([]);
	loading = $state(false);
	saving = $state(false);
	error = $state<string | null>(null);
	name = $state('');
	lifetime = $state<Lifetime>('7d');
	noStoredFilters = $state(false);
	onSaved: (() => void) | null = null;

	kept = $derived(this.tracks.filter((t) => !this.excluded.includes(t.uri)));

	#timer: ReturnType<typeof setTimeout> | undefined;
	#seq = 0;

	openCreate(): void {
		this.mode = 'create';
		this.playlistId = null;
		this.editName = '';
		this.filters = { ...DEFAULT_FILTERS };
		this.excluded = [];
		this.name = '';
		this.lifetime = '7d';
		this.noStoredFilters = false;
		this.#reset();
	}

	openEdit(p: { playlistId: string; name: string; filters: CustomFilters | null; excluded: string[] }, onSaved?: () => void): void {
		this.mode = 'edit';
		this.playlistId = p.playlistId;
		this.editName = p.name;
		this.filters = p.filters ? { ...p.filters } : { ...DEFAULT_FILTERS };
		this.noStoredFilters = !p.filters;
		this.excluded = [...p.excluded];
		this.onSaved = onSaved ?? null;
		this.#reset();
	}

	#reset(): void {
		this.step = 1;
		this.count = null;
		this.tracks = [];
		this.error = null;
		this.open = true;
		this.refresh(0);
	}

	close(): void {
		this.open = false;
		clearTimeout(this.#timer);
	}

	update(patch: Partial<CustomFilters>): void {
		this.filters = { ...this.filters, ...patch };
		this.refresh();
	}

	/** Debounced live count + preview. Only the newest response wins. */
	refresh(delay = DEBOUNCE_MS): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.#load(), delay);
	}

	async #load(): Promise<void> {
		const seq = ++this.#seq;
		this.loading = true;
		try {
			const r = await apiPost<{ count: number; tracks: PreviewTrack[] }>('/api/custom/preview', { filters: this.filters });
			if (seq !== this.#seq) return;
			this.count = r.count;
			this.tracks = r.tracks;
			this.error = null;
		} catch (e) {
			if (seq !== this.#seq) return;
			this.error = e instanceof ApiFailure ? (e.body.message ?? describeFailure(e)) : describeFailure(e);
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	toggle(uri: string): void {
		this.excluded = this.excluded.includes(uri) ? this.excluded.filter((u) => u !== uri) : [...this.excluded, uri];
	}

	async searchArtists(q: string): Promise<{ name: string; plays: number }[]> {
		if (q.trim().length < 2) return [];
		return (await apiGet<{ artists: { name: string; plays: number }[] }>(`/api/custom/artists?q=${encodeURIComponent(q)}`)).artists;
	}

	async save(): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.error = null;
		try {
			if (this.mode === 'create') {
				const r = await apiPost<{ playlistId: string; name: string; trackCount: number }>('/api/custom', {
					name: this.name,
					filters: this.filters,
					excluded: this.excluded,
					lifetime: this.lifetime
				});
				this.close();
				library.invalidate();
				toasts.show(`Created ${r.name} · ${r.trackCount} tracks`);
				await goto(`/playlist/${r.playlistId}`);
			} else {
				const r = await apiPost<{ trackCount: number }>(`/api/custom/${this.playlistId}`, {
					action: 'update',
					filters: this.filters,
					excluded: this.excluded
				});
				this.close();
				toasts.show(`Updated on Spotify · ${r.trackCount} tracks`);
				this.onSaved?.();
			}
		} catch (e) {
			this.error = e instanceof ApiFailure ? (e.body.message ?? describeFailure(e)) : describeFailure(e);
		} finally {
			this.saving = false;
		}
	}
}

export const customSheet = new CustomSheet();
