/** The Library (mirror) + the Rotor-only organiser (pins, folders, custom order), shared by the Library page and the laptop sidebar. */
import { ApiFailure, apiGet, apiPost, apiPut } from '$lib/player/api-client';
import { EMPTY_ORGANISER, type LibraryRow, type Organiser } from '$lib/shared/library';

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
	/** v0.91: pins, folders, custom order (Rotor only; migration 0034). */
	org = $state<Organiser>(EMPTY_ORGANISER);
	/** Set when the organiser isn't available (0034 not applied): pins and folders are hidden. */
	orgError = $state<string | null>(null);
	#synced = false;

	async load(force = false): Promise<void> {
		if (this.loading || (this.loaded && !force)) return;
		this.loading = true;
		try {
			const [r] = await Promise.all([apiGet<LibraryResponse>('/api/playlists'), this.loadOrg()]);
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

	/** v0.92: take over the page's (server-rendered / cached) answer, then refresh as load() would. */
	seed(r: LibraryResponse | null, org: Organiser | null): void {
		if (this.loaded || !r) return;
		this.rows = r.rows;
		this.categories = r.categories;
		if (org) this.org = org;
		this.loaded = true;
		if (!this.#synced && (r.mirrorAgeMin === null || r.mirrorAgeMin > 60)) {
			this.#synced = true;
			void apiPost<{ skipped: boolean }>('/api/playlists/sync')
				.then(async (s) => {
					if (!s.skipped) {
						const again = await apiGet<LibraryResponse>('/api/playlists');
						this.rows = again.rows;
						this.categories = again.categories;
					}
				})
				.catch(() => undefined);
		}
		if (!org) void this.loadOrg();
	}

	async loadOrg(): Promise<void> {
		try {
			this.org = await apiGet<Organiser>('/api/library');
			this.orgError = null;
		} catch (e) {
			this.org = EMPTY_ORGANISER;
			this.orgError = e instanceof ApiFailure && e.status === 503 ? 'Pins and folders need migration 0034.' : 'Could not load your pins and folders.';
		}
	}

	/** Organiser writes (database only, never Spotify), then a fresh organiser. */
	async organise(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<void> {
		const r = method === 'PUT' ? await apiPut<Organiser | object>(path, body) : await apiPost<Organiser | object>(path, body);
		if (r && typeof r === 'object' && 'folders' in r && 'items' in r) this.org = r as Organiser;
		else await this.loadOrg();
	}

	/** After create/delete: reload in the background. */
	invalidate(): void {
		this.loaded = false;
		void this.load(true);
	}
}

export const library = new LibraryStore();
