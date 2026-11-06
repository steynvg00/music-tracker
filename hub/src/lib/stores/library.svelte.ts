/** The Library (mirror), shared by the Library page and the laptop sidebar. */
import { apiGet, apiPost } from '$lib/player/api-client';
import type { LibraryRow } from '$lib/shared/library';

interface LibraryResponse {
	rows: LibraryRow[];
	categories: { key: string; name: string }[];
	mirrorAgeMin: number | null;
}

class LibraryStore {
	rows = $state<LibraryRow[]>([]);
	categories = $state<{ key: string; name: string }[]>([]);
	loaded = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);
	#synced = false;

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			const r = await apiGet<LibraryResponse>('/api/playlists');
			this.rows = r.rows;
			this.categories = r.categories;
			this.loaded = true;
			this.error = null;
			// Mirror older than an hour → refresh it from Spotify once, then reload (04-architecture.md §6.3).
			if (!this.#synced && (r.mirrorAgeMin === null || r.mirrorAgeMin > 60)) {
				this.#synced = true;
				const s = await apiPost<{ skipped: boolean }>('/api/playlists/sync').catch(() => null);
				if (s && !s.skipped) {
					const again = await apiGet<LibraryResponse>('/api/playlists');
					this.rows = again.rows;
					this.categories = again.categories;
				}
			}
		} catch {
			this.error = 'Could not load your library.';
		} finally {
			this.loading = false;
		}
	}

	/** After create/delete: reload in the background. */
	invalidate(): void {
		this.loaded = false;
		void this.load(true);
	}
}

export const library = new LibraryStore();
